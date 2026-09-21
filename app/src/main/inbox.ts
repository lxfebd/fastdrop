/**
 * 收件箱：浏览器扩展投递下载链接的本地入口。
 *
 * 为什么要有这一层：native messaging host 是宿主进程（fastdrop.exe）自己，
 * 但宿主被浏览器拉起时可能连着一个**没在跑**的 FastDrop——它要把链接交给谁？
 * 单实例锁只解决「重复启动」，解决不了「两个进程之间的投递」。收件箱就是这条
 * 跨进程通道：127.0.0.1 随机端口 + 随机 token，token 写在
 * %LOCALAPPDATA%/FastDrop/inbox.json，宿主读它、POST 链接进来，
 * 主进程把链接交给 manager.add。
 *
 * 为什么 inbox.json 不在 dataDir()（~/.fastdrop）里：宿主进程由浏览器拉起，
 * 继承的是**浏览器**的环境变量，而主实例可能带着 FASTDROP_DATA_DIR 覆盖在跑
 * （测试/隔离环境）。两个进程各算各的 dataDir() 就会读到不同的 token。
 * LOCALAPPDATA 是同用户所有进程共有的稳定位置，与测试覆盖无关——主实例和
 * 宿主从这里拿到的永远是同一份配置。这也是「跨进程会合点」的本职：一个
 * 永远不在用户主目录、不参与备份、可随时重建的临时凭据文件。
 *
 * 安全模型：只绑 loopback，且每个请求必须带对 token。token 是 32 字节随机数，
 * 没有 token 的 POST 一律 403——不能装了一个扩展就让任何网页往下载清单里塞东西。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface InboxInfo {
  port: number
  token: string
}

export interface InboxConfig {
  /** manager.add 的同形输入。inbox 只校验边界，业务校验（代理、校验和）留给 manager。 */
  addTask: (input: { url: string; threads?: number; note?: string }) => {
    ok: boolean
    error?: string
    /** 新建任务的 id；duplicate=true 时是已有任务的 id。 */
    id?: string
    duplicate?: boolean
  }
}

const URL_RE = /^(https?|ftp):\/\//i
const MAX_BODY = 64 * 1024

function inboxFile(): string {
  // FASTDROP_INBOX_FILE 供测试隔离：宿主与主实例都从环境拿到同一个路径。
  // 默认落在 LOCALAPPDATA/FastDrop 下，见文件头对「为什么不在 dataDir()」的解释。
  if (process.env.FASTDROP_INBOX_FILE) return process.env.FASTDROP_INBOX_FILE
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return join(local, 'FastDrop', 'inbox.json')
}

/**
 * 读收件箱配置。文件不存在或损坏就当场生成一份新的（随机端口 + token）。
 * 宿主进程每次启动都会读它，所以必须原子写。
 */
export function loadInboxInfo(): InboxInfo {
  const f = inboxFile()
  if (existsSync(f)) {
    try {
      const raw = JSON.parse(readFileSync(f, 'utf8')) as { port?: unknown; token?: unknown }
      if (
        typeof raw.port === 'number' &&
        Number.isInteger(raw.port) &&
        raw.port > 0 &&
        raw.port < 65536 &&
        typeof raw.token === 'string' &&
        raw.token.length >= 16
      ) {
        return { port: raw.port, token: raw.token }
      }
    } catch {
      // 损坏的 inbox.json 直接重写
    }
  }
  const info: InboxInfo = { port: 0, token: randomBytes(32).toString('hex') }
  writeInboxInfo(info)
  return info
}

function writeInboxInfo(info: InboxInfo): void {
  mkdirSync(dirname(inboxFile()), { recursive: true })
  const f = inboxFile()
  const tmp = `${f}.tmp`
  writeFileSync(tmp, JSON.stringify(info, null, 2), 'utf8')
  renameSync(tmp, f)
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8')
      if (data.length > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

/**
 * 启动收件箱 HTTP 服务。端口来自 loadInboxInfo 的随机值——固定端口会被别的
 * 应用占走，且同一台机器上多个 FastDrop 实例（开发跑一个、装了一个）会撞。
 */
export function startInbox(cfg: InboxConfig): Promise<Server> {
  return new Promise((resolve, reject) => {
    const info = loadInboxInfo()
    const server = createServer((req, res) => {
      void handleInbox(req, res, info.token, cfg)
    })
    server.on('error', reject)
    server.listen(info.port, '127.0.0.1', () => {
      // 端口被占时 listen 会失败、走 error 分支；走到这里说明绑定成功。
      // 万一随机端口被系统换成别的值，把实际端口写回 inbox.json，宿主永远读它。
      const addr = server.address()
      if (addr && typeof addr === 'object' && addr.port !== info.port) {
        writeInboxInfo({ port: addr.port, token: info.token })
      }
      resolve(server)
    })
  })
}

async function handleInbox(req: IncomingMessage, res: ServerResponse, token: string, cfg: InboxConfig): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' })
    return
  }
  if (req.headers.authorization !== `Bearer ${token}`) {
    sendJson(res, 403, { ok: false, error: 'unauthorized' })
    return
  }
  let body: unknown
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    sendJson(res, 400, { ok: false, error: 'bad json' })
    return
  }
  const raw = (body ?? {}) as Record<string, unknown>
  const url = typeof raw.url === 'string' ? raw.url.trim() : ''
  if (!URL_RE.test(url)) {
    sendJson(res, 400, { ok: false, error: 'invalid url' })
    return
  }
  const threads = Number.isFinite(raw.threads) ? Number(raw.threads) : undefined
  const note = typeof raw.note === 'string' ? raw.note.slice(0, 500) : ''
  const outcome = cfg.addTask({ url, threads, note })
  sendJson(res, outcome.ok ? 200 : 422, outcome)
}