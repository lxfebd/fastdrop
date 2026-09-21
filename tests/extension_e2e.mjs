// 浏览器扩展端到端（真实 Edge/Chrome + 打包后的 fastdrop.exe 作为宿主）。
//
// 覆盖整条链路：打包应用启动时**自动注册** native messaging 宿主（见
// hostRegister.ts，写 HKCU 注册表 + manifest）→ 扩展 service worker 发
// native message → 浏览器按注册表拉起宿主（argv[1]=chrome-extension://id）→
// 宿主读帧 → POST 收件箱 → 主实例 manager.add → 任务落进 tasks.json。
// 这正是「下载不用复制链接」的用户路径，离线门盖不到浏览器侧的部分
// （宿主被发现、被 spawn、帧协议在真浏览器里走一遍）都由这一支补。
//
// 本脚本全程隔离：Edge 用全新 --user-data-dir，主实例用临时 FASTDROP_DATA_DIR /
// FASTDROP_INBOX_FILE —— 宿主继承 Chrome 的环境，所以两边的 inbox 变量必须一致。
// 原子操作里会自动写入 HKCU 的 NativeMessagingHosts 键（正是产品在每台机器上
// 的行为），finally 里删除恢复原状。
//
// 前置：cd app && npm run dist:dir（产出 release/win-unpacked/fastdrop.exe）
//
// 用法：
//   node tests/extension_e2e.mjs [--edge|--chrome] [--keep]
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const ROOT = path.join('J:', 'xiangm_transfer', 'galgame')
const APP = path.join(ROOT, 'app')
const EXT = path.join(ROOT, 'extension')
const FASTDROP = path.join(APP, 'release', 'win-unpacked', 'fastdrop.exe')
const ENGINE = path.join(ROOT, 'engine-rs', 'target', 'release', 'fastdrop-engine.exe')
// 隔离根目录：主实例 HOME / Edge profile / 下载目录 全在这里面
const SANDBOX = mkdtempSync(path.join(tmpdir(), 'fd-ext-e2e-'))
const MAIN_HOME = path.join(SANDBOX, 'main-home')
const MAIN_DATA = path.join(SANDBOX, 'main-data')
const MAIN_USERDATA = path.join(SANDBOX, 'main-userdata')
const INBOX_FILE = path.join(SANDBOX, 'inbox.json')
const EDGE_PROFILE = path.join(SANDBOX, 'edge-profile')
const DL_DIR = path.join(SANDBOX, 'downloads')
for (const d of [MAIN_HOME, MAIN_DATA, MAIN_USERDATA, DL_DIR, EDGE_PROFILE]) fs.mkdirSync(d, { recursive: true })

const REG_KEYS = [
  'HKCU\\SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts\\com.fastdrop.host',
  'HKCU\\SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\com.fastdrop.host',
  'HKCU\\SOFTWARE\\Chromium\\NativeMessagingHosts\\com.fastdrop.host',
]

const BROWSER = process.argv.includes('--chrome') ? 'chrome' : 'edge'
const KEEP = process.argv.includes('--keep')
const browserExe =
  BROWSER === 'edge'
    ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
    : 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const EXT_ID = 'gnlgecbjgmkieigjojcpifcjncmjjecj'

const results = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function check(name, ok, detail = '') {
  results.push({ name, ok })
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + String(detail).slice(0, 300) : ''}`
  // 同时写 stderr：挂在 stdout 上的未捕获异常会把 stdout 缓冲吞掉，
  // 只留 stderr 能让失败现场完整可见
  console.log(line)
  console.error(line)
}
async function waitFor(label, fn, timeoutMs = 30000, stepMs = 250) {
  const until = Date.now() + timeoutMs
  for (;;) {
    let v
    try {
      v = await fn()
    } catch {
      v = undefined
    }
    if (v) return v
    if (Date.now() > until) throw new Error(`timeout waiting for ${label}`)
    await sleep(stepMs)
  }
}

// ---------------------------------------------------------------- CDP：标准 WebSocket
class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    this.listeners = new Map()
    ws.addEventListener('message', (ev) => {
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      } else if (msg.method && this.listeners.has(msg.method)) {
        for (const fn of this.listeners.get(msg.method)) fn(msg.params)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set())
    this.listeners.get(method).add(fn)
    return () => this.listeners.get(method).delete(fn)
  }
  close() {
    try {
      this.ws.close()
    } catch {}
  }
}

async function openCdp(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })
  return new Cdp(ws)
}

/**
 * 通过 CDP 的 Extensions.loadUnpacked 加载本地扩展目录。
 * Chrome 137+ 把命令行 --load-extension 从品牌版移除了（RFC 见
 * chromestatus / chromium-extensions 论坛），官方替代就是
 * --remote-debugging-* 加 Extensions 域的这条（bitcrowd.dev 2025 与
 * cypress#31690 都引了同一份官方说明）。Edge 上 --load-extension 仍工作，
 * 但走同一路径更未来安全：浏览器必须带 --enable-unsafe-extension-debugging。
 * 返回扩展 ID；加载失败（error 或空 id）返回 null。
 */
async function loadExtensionViaCdp(cdpPort, extPath) {
  let browserCdp
  try {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`)
    const browserInfo = await res.json()
    if (!browserInfo.webSocketDebuggerUrl) return null
    browserCdp = await openCdp(browserInfo.webSocketDebuggerUrl)
    const r = await browserCdp.send('Extensions.loadUnpacked', { path: extPath })
    const id = r && typeof r.id === 'string' ? r.id : null
    return id
  } catch {
    return null
  } finally {
    if (browserCdp) browserCdp.close()
  }
}

async function jsonTargets(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`)
    return await res.json()
  } catch {
    return []
  }
}

// ---------------------------------------------------------------- 本地下载服务器
function startFileServer() {
  const file = Buffer.alloc(1024 * 1024, 0x61)
  const server = http.createServer((req, res) => {
    if (req.url === '/file.zip') {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': file.length })
      res.end(file)
    } else if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><body><a id="dl" href="/file.zip">下载文件</a></body></html>')
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

// ---------------------------------------------------------------- 注册表快照
// 主实例启动时会自动写入 HKCU 的宿主键（产品行为）。跑完必须把注册表
// 恢复成**跑之前**的状态：预先存在的键连同值一起还原，没有的键删掉。
// 这样即使这台机器上已经装了 FastDrop，e2e 也不会破坏它的注册。
function snapshotReg() {
  const snap = []
  for (const root of REG_KEYS) {
    try {
      const out = execFileSync('reg', ['query', root, '/ve'], { stdio: 'pipe', encoding: 'utf8' })
      // 输出形如：  <key>\r\n    (default)    REG_SZ    C:\path\to\manifest.json
      const m = out.match(/\(default\)\s+REG_SZ\s+(\S+)/i)
      snap.push({ key: root, existed: true, value: m ? m[1] : null })
    } catch {
      snap.push({ key: root, existed: false, value: null })
    }
  }
  return snap
}

function restoreReg(snap) {
  for (const s of snap) {
    try {
      if (s.existed) {
        execFileSync('reg', ['add', s.key, '/ve', '/d', s.value || '', '/f'], { stdio: 'ignore' })
      } else {
        execFileSync('reg', ['delete', s.key, '/f'], { stdio: 'ignore' })
      }
    } catch {
      // 恢复了什么不重要：尽量把状态还原到跑之前，失败也到此为止
    }
  }
}

// ---------------------------------------------------------------- 主实例
function envForMain() {
  return {
    ...process.env,
    FASTDROP_DATA_DIR: MAIN_DATA,
    FASTDROP_INBOX_FILE: INBOX_FILE,
    // --user-data-dir 让 app.getPath('userData') 落在沙箱里：宿主自动注册
    // 写出的 manifest 与 HKCU 键都指向沙箱路径，跑完删沙箱即可，绝不碰真实
    // %APPDATA%\fastdrop。
    USERPROFILE: MAIN_HOME,
    HOME: MAIN_HOME,
    APPDATA: path.join(MAIN_HOME, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(MAIN_HOME, 'AppData', 'Local'),
  }
}

async function startMain() {
  fs.mkdirSync(path.join(MAIN_DATA, '..'), { recursive: true })
  const settings = { download_dir: DL_DIR, notify_on_finish: false, notify_on_error: false }
  fs.writeFileSync(path.join(MAIN_DATA, 'settings.json'), JSON.stringify(settings, null, 2))
  const child = spawn(FASTDROP, [`--user-data-dir=${MAIN_USERDATA}`], {
    env: envForMain(),
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  await waitFor(
    'inbox.json',
    () => fs.existsSync(INBOX_FILE) && JSON.parse(fs.readFileSync(INBOX_FILE, 'utf8')).port,
    30000,
  )
  const info = JSON.parse(fs.readFileSync(INBOX_FILE, 'utf8'))
  return { child, info }
}

async function readMainTasks() {
  const f = path.join(MAIN_DATA, 'tasks.json')
  if (!fs.existsSync(f)) return []
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------- 浏览器
function launchBrowser(port) {
  const args = [
    `--user-data-dir=${EDGE_PROFILE}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-popup-blocking',
    // Extensions.loadUnpacked 域的前置开关：Chrome 137+ 移除命令行
    // --load-extension 后，官方替代是 CDP 加载 + 这个 flag（见
    // loadExtensionViaCdp 的注释）。Edge 上加载扩展同样需要它。
    '--enable-unsafe-extension-debugging',
    'about:blank',
  ]
  return spawn(browserExe, args, {
    // 宿主进程由浏览器拉起，继承的是**浏览器的环境**：两个隔离变量必须在这
    // 里传下去，宿主才能找到与主实例一致的收件箱凭据与数据目录。
    env: {
      ...process.env,
      FASTDROP_INBOX_FILE: INBOX_FILE,
      FASTDROP_DATA_DIR: MAIN_DATA,
    },
    stdio: 'ignore',
  })
}

// ---------------------------------------------------------------- 主流程
async function main() {
  // 清掉上一轮可能残留的 fastdrop 实例（它们握着单实例锁会挡住本轮启动）
  try {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='fastdrop.exe'" | Where-Object { $_.CommandLine -like '*fd-ext-e2e-*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
      ],
      { stdio: 'ignore' },
    )
  } catch {}
  await sleep(800)
  const fileServer = await startFileServer()
  const PORT = fileServer.address().port
  const url = `http://127.0.0.1:${PORT}/file.zip`
  const cdpPort = 9435 + Math.floor(Math.random() * 100)
  let browser = null
  // 主实例启动会自动写宿主注册表键（产品行为），先快照以便 finally 原样恢复
  const regSnap = snapshotReg()
  try {
    check('前置：打包产物存在', fs.existsSync(FASTDROP), FASTDROP)
    check('前置：引擎二进制存在', fs.existsSync(ENGINE), ENGINE)
    check('前置：扩展 manifest 合法', (() => {
      const m = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'))
      return m.manifest_version === 3 && m.permissions.includes('nativeMessaging')
    })())

    const main = await startMain()
    check('主实例：收件箱就绪（port=' + main.info.port + '）', main.info.port > 0)

    // 产品行为断言：打包应用首次启动自动注册宿主——manifest 落在沙箱 userData、
    // HKCU 三个键指向它。缺了它，浏览器永远「找不到 com.fastdrop.host」。
    const hostManifest = path.join(MAIN_USERDATA, 'com.fastdrop.host.json')
    check('宿主 manifest 已由主实例自动写入', fs.existsSync(hostManifest), hostManifest)
    let regRegistered = true
    for (const root of REG_KEYS) {
      try {
        const out = execFileSync('reg', ['query', root, '/ve'], { stdio: 'pipe', encoding: 'utf8' })
        if (!out.includes(hostManifest)) regRegistered = false
      } catch {
        regRegistered = false
      }
    }
    check('HKCU 宿主键已注册且指向沙箱 manifest', regRegistered)

    browser = launchBrowser(cdpPort)
    await waitFor('CDP targets', async () => (await jsonTargets(cdpPort)).length > 0, 30000)

    // Chrome 137+ 移除了命令行 --load-extension，这里走官方替代：
    // CDP 的 Extensions.loadUnpacked 加载本地扩展（见 loadExtensionViaCdp）。
    const loadedId = await loadExtensionViaCdp(cdpPort, EXT)
    check('扩展经 CDP 加载', loadedId === EXT_ID, loadedId)

    const sw = await waitFor(
      'service worker target',
      async () => (await jsonTargets(cdpPort)).find((t) => t.type === 'service_worker' && t.url.includes(EXT_ID)),
      30000,
    )
    check('扩展 service worker 已加载', !!sw, sw && sw.url)

    // 页面导航，保证扩展对本 origin 有 host 权限
    const pageTarget = await waitFor(
      'page target',
      async () => (await jsonTargets(cdpPort)).find((t) => t.type === 'page'),
      30000,
    )
    const page = await openCdp(pageTarget.webSocketDebuggerUrl)
    await page.send('Page.enable')
    await page.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
    await sleep(1000)

    // 在 SW 上下文里发真实 native message（宿主调用链）
    const swCdp = await openCdp(sw.webSocketDebuggerUrl)
    await swCdp.send('Runtime.enable')
    const res = await swCdp.send('Runtime.evaluate', {
      expression: `(async () => {
        return await new Promise((resolve) => {
          chrome.runtime.sendNativeMessage('com.fastdrop.host', { type: 'add-task', url: ${JSON.stringify(url)}, note: 'e2e' }, (resp) => {
            if (chrome.runtime.lastError) resolve({ lastError: chrome.runtime.lastError.message })
            else resolve(resp)
          })
        })
      })()`,
      awaitPromise: true,
      returnByValue: true,
      timeout: 20000,
    })
    // 诊断输出：evaluate 可能因异常/超时返回，把原始结果打出来再断言
    const remoteObj = res && res.result ? res.result : null
    const value = remoteObj && typeof remoteObj.value !== 'undefined' ? remoteObj.value : undefined
    const exceptionDesc = res.exceptionDetails
      ? JSON.stringify(res.exceptionDetails).slice(0, 400)
      : remoteObj && remoteObj.description
        ? String(remoteObj.description).slice(0, 400)
        : ''
    check(
      '宿主响应帧 ok',
      !!value && value.ok === true && !value.lastError,
      JSON.stringify(value ?? exceptionDesc ?? '无响应').slice(0, 300),
    )

    const task = await waitFor(
      '任务入列',
      async () => (await readMainTasks()).find((t) => t.url === url),
      30000,
    )
    check('任务已入列（浏览器 → 宿主 → 收件箱 → manager）', !!task, task && task.dest)

    const done = await waitFor(
      '任务下载完成',
      async () => {
        const t = (await readMainTasks()).find((x) => x.url === url)
        return t && t.state === 'done'
      },
      60000,
      500,
    )
    check('任务下载完成（引擎走通）', done === true)
    const destFile = task && task.dest
    check('文件落盘', destFile && fs.existsSync(destFile), destFile)
  } finally {
    if (!KEEP) {
      try {
        browser && browser.kill()
      } catch {}
      try {
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            // 主实例命令行里只有 --user-data-dir=...（沙箱根），没有 MAIN_DATA
            // 子串；按沙箱根过滤才能命中主进程和它的 gpu/utility/renderer 子进程
            `Get-CimInstance Win32_Process -Filter "Name='fastdrop.exe'" | Where-Object { $_.CommandLine -like '*${SANDBOX}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
          ],
          { stdio: 'ignore' },
        )
      } catch {}
      try {
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `Get-CimInstance Win32_Process -Filter "Name='fastdrop-engine.exe'" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
          ],
          { stdio: 'ignore' },
        )
      } catch {}
      try {
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `Get-CimInstance Win32_Process -Filter "Name='${BROWSER === 'edge' ? 'msedge.exe' : 'chrome.exe'}'" | Where-Object { $_.CommandLine -like '*${EDGE_PROFILE}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
          ],
          { stdio: 'ignore' },
        )
      } catch {}
      // 恢复注册表到跑之前的状态（见 snapshotReg/restoreReg）
      restoreReg(regSnap)
      // 等文件句柄释放：杀完进程立刻 rm 会撞 EPERM（子进程还握着 profile/.part）
      await sleep(1500)
      try {
        fs.rmSync(SANDBOX, { recursive: true, force: true, retryDelay: 200, maxRetries: 10 })
      } catch (e) {
        console.log(`注意：沙箱目录清理失败（${e.message}），可手动删除：${SANDBOX}`)
      }
    } else {
      console.log(`保留沙箱：${SANDBOX}`)
      console.log(`主实例数据：${MAIN_DATA}（tasks.json 就是结果）`)
    }
    fileServer.close()
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}

await main()