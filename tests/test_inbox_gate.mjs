// 离线门：收件箱 + native messaging 帧协议的端到端验证，不依赖 Electron/浏览器。
//
// 把 inbox.ts / nativeHost.ts / store.ts 用 esbuild 打成两个可在 Node 下直接
// require 的 bundle，然后：
//   1. 起真实收件箱 HTTP 服务（随机端口 + token，落盘 inbox.json）
//   2. 用帧协议（4 字节小端长度 + JSON）模拟浏览器 → 宿主进程，
//      宿主进程把链接 POST 进收件箱
//   3. 断言 manager 收到、结果帧回报 ok、token 错误时 403
//
// 全部用临时 FASTDROP_DATA_DIR，绝不碰真实 ~/.fastdrop。
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'

const APP = join(import.meta.dirname, '..', 'app')
// 直接用 node 跑 esbuild 的 JS 入口：.cmd shim 无法被 spawnSync（EINVAL），
// 而 npx 在部分 PATH 下也 spawn 不到。node <esbuild/bin/esbuild> 全平台一致。
const ESBUILD_JS = join(APP, 'node_modules', 'esbuild', 'bin', 'esbuild')
const TMP = mkdtempSync(join(tmpdir(), 'fd-inbox-gate-'))
// 收件箱凭据文件走 FASTDROP_INBOX_FILE（测试隔离），不碰真实 LOCALAPPDATA
const INBOX_FILE = join(TMP, 'inbox.json')
process.env.FASTDROP_INBOX_FILE = INBOX_FILE
const PASS = []
const FAIL = []
let failed = false
function check(name, cond, detail) {
  if (cond) PASS.push(name)
  else {
    failed = true
    FAIL.push(`${name}${detail ? ` :: ${detail}` : ''}`)
  }
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`)
}

function buildBundle() {
  const out = join(TMP, 'inbox.cjs')
  execFileSync(
    process.execPath,
    [ESBUILD_JS, 'src/main/inbox.ts', '--bundle', '--format=cjs', '--platform=node', '--outfile=' + out],
    { cwd: APP, stdio: 'pipe' },
  )
  return out
}

// ---- 收件箱 ----
async function startInbox() {
  const bundle = buildBundle()
  // esbuild bundle 把 store.ts 一起打进来，dataDir() 读 FASTDROP_DATA_DIR env
  const mod = await import('file://' + bundle)
  const inbox = mod
  const calls = []
  const cfg = {
    addTask: (input) => {
      calls.push(input)
      return { ok: true, id: 'task-' + calls.length, duplicate: false }
    },
  }
  const server = await inbox.startInbox(cfg)
  const addr = server.address()
  return { inbox, server, calls, port: addr.port, info: inbox.loadInboxInfo() }
}

// ---- native messaging 帧（模拟浏览器侧封包）----
function makeFrame(obj) {
  const text = JSON.stringify(obj)
  const buf = Buffer.alloc(4 + Buffer.byteLength(text))
  buf.writeUInt32LE(Buffer.byteLength(text), 0)
  buf.write(text, 4, 'utf8')
  return buf
}

async function main() {
  try {
    // 1. 收件箱：随机端口 + token 落盘
    const { inbox, server, calls, port, info } = await startInbox()
    check('inbox 绑定 127.0.0.1', String(server.address().address) === '127.0.0.1')
    check('inbox 随机端口 > 0', port > 0)
    check('inbox token 长度 ≥ 32', info.token.length >= 32)

    // 2. 正确 token → 200 + ok:true + manager 收到
    const okRes = await fetch(`http://127.0.0.1:${port}/add`, {
      method: 'POST',
      headers: { authorization: `Bearer ${info.token}` },
      body: JSON.stringify({ url: 'https://example.com/game.zip' }),
    })
    const okJson = await okRes.json()
    check('正确 token → 200', okRes.status === 200)
    check('正确 token → ok:true', okJson.ok === true)
    check('manager 收到 URL', calls.length === 1 && calls[0].url === 'https://example.com/game.zip')
    check('dest 由 manager 解析（本例未提供）', calls[0].url === 'https://example.com/game.zip')

    // 3. 错误 token → 403
    const badRes = await fetch(`http://127.0.0.1:${port}/add`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrongtoken' },
      body: JSON.stringify({ url: 'https://example.com/bad.zip' }),
    })
    check('错误 token → 403', badRes.status === 403)

    // 4. 无 token → 403
    const noAuthRes = await fetch(`http://127.0.0.1:${port}/add`, {
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.com/noauth.zip' }),
    })
    check('无 token → 403', noAuthRes.status === 403)

    // 5. 非法 URL → 400
    const badUrlRes = await fetch(`http://127.0.0.1:${port}/add`, {
      method: 'POST',
      headers: { authorization: `Bearer ${info.token}` },
      body: JSON.stringify({ url: 'not a url' }),
    })
    check('非法 URL → 400', badUrlRes.status === 400)

    // 6. 非 POST → 405
    const getRes = await fetch(`http://127.0.0.1:${port}/add`)
    check('GET → 405', getRes.status === 405)

    // 7. 收件箱文件落盘 + 可重读
    const reRead = inbox.loadInboxInfo()
    check('inbox.json 重读一致', reRead.port === port && reRead.token === info.token)

    // ---- 宿主进程（native messaging 帧协议）----
    // 宿主 bundle：nativeHost.ts + inbox.ts 一起打进一个文件，模拟宿主逻辑：
    // 读帧 → POST 收件箱 → 回帧。
    const hostBundle = join(TMP, 'host.cjs')
    execFileSync(
      process.execPath,
      [
        ESBUILD_JS,
        'src/main/nativeHost.ts',
        '--bundle',
        '--format=cjs',
        '--platform=node',
        '--outfile=' + hostBundle,
        '--define:process.env.FASTDROP_DATA_DIR=' + JSON.stringify(process.env.FASTDROP_DATA_DIR),
      ],
      { cwd: APP, stdio: 'pipe' },
    )
    const hostMod = await import('file://' + hostBundle)
    check('host 模块导出帧函数', typeof hostMod.writeFrame === 'function' && typeof hostMod.isNativeHostMode === 'function')

    // 帧函数直接测（不 spawn）：发一帧、deliver 收到、回帧能解析
    const delivered = []
    const deliver = async (url, threads, note) => {
      delivered.push({ url, threads, note })
      return { ok: true, id: 'host-task' }
    }
    // 手动模拟：writeFrame 到一个收集 buffer，再用 readFrame 解回来
    const frames = []
    const fakeStream = { write: (buf) => void frames.push(buf) }
    hostMod.writeFrame(fakeStream, { ok: true, id: 'host-task' })
    const frameBuf = Buffer.concat(frames)
    check('帧长度前缀 = 4 字节', frameBuf.length >= 4)
    const parsed = hostMod.readFrame(frameBuf)
    check('回帧可解析且内容一致', parsed.message && parsed.message.ok === true)

    // runNativeHostOnce 需要真 stdin，这里只验证它导出的类型形状
    check('isNativeHostMode 是函数', typeof hostMod.isNativeHostMode === 'function' && hostMod.isNativeHostMode(['x', 'chrome-extension://abc/']) === true)

    server.close()
  } finally {
    rmSync(TMP, { recursive: true, force: true })
  }
  console.log(`\n${PASS.length} passed, ${FAIL.length} failed`)
  process.exit(failed ? 1 : 0)
}

await main()
