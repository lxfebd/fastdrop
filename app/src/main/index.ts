/**
 * Electron 主进程入口。
 *
 * 职责：起窗口、管托盘、持有调度器、把任务事件透传给渲染进程。
 * 渲染进程不直接接触 Node 和文件系统——一切经由 preload 的 contextBridge。
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, powerSaveBlocker, shell, Tray } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Ipc } from '../shared/ipc'
import { explainError } from '../shared/errors'
import { fileName, fmtSize, fmtSpeed } from '../shared/format'
import type { TaskRow } from '../shared/types'
import { normalizeChecksum } from '../shared/types'
import { Manager } from './manager'
import { normalizeSettings, Store, dataDir } from './store'
import { applyChromiumProxy } from './netConfig'
import { proxyFormatError } from '../shared/proxy'
import { TRAY_ICON_DATA_URL } from './trayIcon'
import { UiRescue } from './uiRescue'
import { wireSites } from './sites/bridge'
import { loadInboxInfo, startInbox } from './inbox'
import { registerNativeHost } from './hostRegister'
import { setupUpdater, checkForUpdate, installUpdate, updateStatus, syncAutoCheck } from './updater'

/**
 * 主进程自己算 preload 路径。electron-vite 不会注入 preload 的绝对路径，
 * 早期写的 process.env.ELECTRON_VITE_PRELOAD 是凭空编的变量，永远是 undefined，
 * 那 preload 根本不会加载，window.fd 也就一直不存在。
 *
 * 主进程以 ESM 形式构建，__dirname 不可用，只能用 import.meta.url 反推。
 */
const here = dirname(fileURLToPath(import.meta.url))
const preloadPath = join(here, '../preload/index.cjs')

// Windows 的通知中心按「应用用户模型 ID」归属 toast。不设这一行，
// 下载完成通知要么整个不显示，要么挂着 "electron.app.Electron" 的名字出现，
// 用户不知道是谁在说话。取值和 electron-builder.yml 的 appId 保持一致——
// 安装包里 NSIS 建的快捷方式用的就是这个 ID，两边对上 toast 才能带图标和名称。
app.setAppUserModelId('com.fastdrop.app')

// ---------------------------------------------------------------- 单实例
//
// 以前没有这把锁：从快捷方式点两次就起两个进程，两份内存里的任务表互不知情，
// 而 tasks.json 是全量覆盖写——后写的那份会把另一份的记录整段抹掉。实测过：
// B 实例里新建的任务在磁盘上消失了，而它的窗口还在显示它。
// 更糟的是两个引擎子进程会同时写同一个 .part 文件，直接把断点数据写坏。
// 注意：浏览器扩展不经过这里——manifest 的 path 指向独立 Rust host
// （resources/fastdrop-host.exe），Electron 永远不被浏览器拉起，见 hostRegister.ts。
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  // 第二实例被拉起（快捷方式点两下、--inbox-add 投递）：把主窗口唤到前台。
  // --inbox-add 的投递在 below（handleCliAdd）里做，这里只负责让人看见。
  app.on('second-instance', (_e, argv) => {
    showWindow()
    handleCliAdd(argv)
  })
}

/** `--inbox-add <url>` 命令行投递：从命令行参数里取出链接交给收件箱。 */
function handleCliAdd(argv: string[]): void {
  let url = ''
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--inbox-add') {
      url = argv[i + 1] ?? ''
      break
    }
  }
  if (!/^(https?|ftp):\/\//i.test(url.trim())) return
  const info = loadInboxInfo()
  const body = JSON.stringify({ url: url.trim() })
  // 主实例可能还在启动（收件箱没就绪），第二实例就已被拉起：短时重试，
  // 别让用户点的一下静默丢链接。15 秒后还没连上就放弃。
  const attempts = process.env.FASTDROP_INBOX_MAX_RETRIES ? Number(process.env.FASTDROP_INBOX_MAX_RETRIES) : 30
  const delay = 500
  let tryCount = 0
  const post = (): void => {
    tryCount++
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2000)
    fetch(`http://127.0.0.1:${info.port}/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${info.token}` },
      body,
      signal: controller.signal,
    })
      .then((res) => res.json() as Promise<{ ok: boolean; error?: string }>)
      .then((r) => {
        if (!r.ok) console.error('[inbox] 投递被拒绝：', r.error)
      })
      .catch(() => {
        if (tryCount < attempts) setTimeout(post, delay)
      })
      .finally(() => clearTimeout(timer))
  }
  post()
}

let win: BrowserWindow | null = null
let tray: Tray | null = null
let trayTimer: ReturnType<typeof setInterval> | null = null
let store: Store
let manager: Manager
let rescue: UiRescue | null = null

/** 把主窗口从托盘里唤到前台。托盘点击、二次启动、activate 都走这里。 */
function showWindow(): void {
  if (!win || win.isDestroyed()) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/**
 * 加载界面本体。兜底页的「重新加载界面」也走这里，所以它必须是唯一一个
 * 知道 dev URL / 生产产物路径的地方——否则重试会跟第一次加载走两套逻辑。
 */
function loadUi(): void {
  if (!win || win.isDestroyed()) return
  // ELECTRON_RENDERER_URL 是 electron-vite 开发模式唯一注入的真实变量；
  // 生产构建读已编译好的渲染产物，路径相对主进程文件位置计算。
  const devUrl = process.env.ELECTRON_RENDERER_URL
  rescue?.arm()
  // 失败原因由 did-fail-load 变成兜底页上那句人话，这里吞掉的只是同一次失败的
  // Promise 拒绝（不吞就是未捕获拒绝，而主进程里一条未捕获拒绝足以让整个进程没掉）。
  const load = devUrl ? win.loadURL(devUrl) : win.loadFile(join(here, '../renderer/index.html'))
  void load.catch(() => {})
}

/**
 * 「再试一次」的唯一入口：兜底页上的按钮和托盘菜单都指到这里，
 * 免得两条路走成两套行为。
 */
function retryUiLoad(): void {
  if (!win || win.isDestroyed()) {
    createWindow() // 它自己会 loadUi，别再叠一次导航
    return
  }
  showWindow()
  loadUi()
}

/**
 * 界面起不来时的兜底：把原因写清楚，并把「重载 / 打开数据目录 / 退出」交到用户手里。
 * 只建一次，跨窗口复用——窗口会被重建（销毁后从托盘再开），而这几条出口不该丢。
 */
function ensureRescue(): UiRescue {
  if (rescue) return rescue
  rescue = new UiRescue({
    pageDir: app.getPath('userData'),
    dataDir: dataDir(),
    downloadDir: () => store.loadSettings().download_dir,
    getWindow: () => win,
    reloadUi: retryUiLoad,
    quitApp: () => quit(),
  })
  ipcMain.on(Ipc.UiReady, () => rescue?.markReady())
  ipcMain.on(Ipc.UiBootError, (_e, msg: unknown) =>
    rescue?.noteBootError(typeof msg === 'string' ? msg : String(msg)),
  )
  return rescue
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1240,
    height: 780,
    minWidth: 1080,
    minHeight: 620,
    title: 'FastDrop · 游戏下载盒子',
    autoHideMenuBar: true,
    backgroundColor: store.loadSettings().dark ? '#141414' : '#f5f5f5',
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      // 游戏页签用 <webview> 加载 gamer520/nekogal/playzip；默认关闭，只
      // 在需要时开。webview 在沙箱化 preload 下也能用，但要显式开开关。
      webviewTag: true,
    },
  })

  win.once('ready-to-show', () => win?.show())

  // 界面坏了也要留一条用户自己走得通的出口。挂在 webContents 上而不是窗口上：
  // 每次新建窗口都是新的 webContents，而兜底逻辑本身跨窗口复用（见 ensureRescue）。
  ensureRescue().attach(win.webContents)

  // 下载完成/失败时如果窗口不在前台会闪任务栏图标（见 notifyTerminal）。
  // 用户一点回来就得停：闪个不停的图标比通知本身更招人烦。
  win.on('focus', () => win?.flashFrame(false))

  // 窗口内的外链交给系统浏览器，不要开新的 Electron 窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  loadUi()
}

function createTray(): void {
  // 之前这里传的是 nativeImage.createEmpty()：托盘上看不见任何图标，而关窗只
  // 是 hide()，于是软件变成既找不到窗口也找不到退出入口的僵尸进程。
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL)
  tray = new Tray(icon)
  tray.setToolTip('FastDrop · 游戏下载盒子')
  // 菜单在右键那一刻才组装，而不是 setContextMenu 一次定死：托盘里的
  // 「全部暂停 / 重试失败」要按当前任务情况亮灭，预先挂好的菜单永远是旧状态。
  tray.on('right-click', () => tray?.popUpContextMenu(buildTrayMenu()))
  tray.on('click', () => showWindow())
  refreshTray()
  trayTimer = setInterval(refreshTray, 1000)
}

/** 托盘悬浮提示：软件藏在托盘时，这是唯一的「它还在干活」的证据。 */
function trayTooltip(): string {
  if (!manager) return 'FastDrop · 游戏下载盒子'
  const c = manager.statusCounts()
  const bits = [`FastDrop · ${c.downloading} 个下载中`]
  if (manager.totalSpeed() > 0) bits.push(fmtSpeed(manager.totalSpeed()))
  if (c.done) bits.push(`完成 ${c.done}`)
  if (c.error) bits.push(`失败 ${c.error}`)
  if (c.paused) bits.push(`暂停 ${c.paused}`)
  return bits.join(' · ')
}

function buildTrayMenu(): Menu {
  const c = manager?.statusCounts()
  return Menu.buildFromTemplate([
    { label: '显示窗口', click: () => showWindow() },
    { type: 'separator' },
    {
      label: '全部开始',
      enabled: !!c && (c.paused > 0 || c.queued > 0 || c.error > 0),
      click: () => void manager?.actionAll('start'),
    },
    {
      label: '全部暂停',
      enabled: !!c && c.downloading > 0,
      click: () => void manager?.actionAll('pause'),
    },
    {
      label: '重试全部失败',
      enabled: !!c && c.error > 0,
      click: () => void manager?.retryFailed(),
    },
    {
      label: '清空已完成',
      enabled: !!c && c.done > 0,
      click: () => void manager?.actionAll('clear-finished'),
    },
    { type: 'separator' },
    // 界面白屏时窗口本身可能连按钮都点不动，托盘是剩下的唯一入口。
    // 「重载界面」管渲染层坏了；「打开数据目录」管重载也没用时用户需要拿走什么。
    { label: '重新加载界面', click: () => retryUiLoad() },
    {
      label: '打开数据目录',
      click: () => {
        const why = shell.openPath(dataDir())
        if (why) dialog.showErrorBox('打不开数据目录', `${why}\n${dataDir()}`)
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => quit() },
  ])
}

/** 每秒同步一次托盘文字与系统休眠抑制。窗口关了也必须继续跑，所以走定时器。 */
function refreshTray(): void {
  if (!manager) return
  try {
    tray?.setToolTip(trayTooltip())
  } catch {
    // 托盘在某些时刻（系统休眠恢复的一瞬）会拒绝写入，不影响下载本身
  }
  syncKeepAwake()
}

// ---------------------------------------------------------------- 防休眠
//
// prevent-app-suspension 而不是 prevent-display-sleep：合集动辄十几 GB，要的是
// 「别睡过去把下载掐了」，不是「屏幕一直亮着」。默认关（keep_awake=false），
// 因为改变系统电源行为必须由用户点头。
let awakeBlockerId = -1

function releaseKeepAwake(): void {
  if (awakeBlockerId === -1) return
  if (powerSaveBlocker.isStarted(awakeBlockerId)) powerSaveBlocker.stop(awakeBlockerId)
  awakeBlockerId = -1
}

function syncKeepAwake(): void {
  const want = manager?.settings.keep_awake === true && manager.running() > 0
  if (want) {
    if (awakeBlockerId === -1) awakeBlockerId = powerSaveBlocker.start('prevent-app-suspension')
  } else {
    releaseKeepAwake()
  }
}

// ---------------------------------------------------------------- 系统通知
//
// 只有终态（done / error）才弹，去重已经做在 Manager.notifyTerminal 里。
// 失败通知必须带上 errors.ts 翻译过的中文原因和建议：窗口收起来时任务失败了，
// 用户唯一的线索就是这条 toast，光写「下载失败」等于没写。
function notifyTerminal(row: TaskRow): void {
  const s = store.loadSettings()
  const st = row.snap?.state ?? row.def.state
  const name = fileName(row.def.dest) || row.def.url
  const frontmost = !!win && !win.isDestroyed() && win.isVisible() && win.isFocused()
  if (st === 'done' && s.notify_on_finish) {
    const total = row.snap?.total || row.def.total
    notify(
      frontmost,
      `${name} 下载完成`,
      total ? `已保存到 ${dirname(row.def.dest)}（${fmtSize(total)}）` : `已保存到 ${dirname(row.def.dest)}`,
      row.id,
    )
  } else if (st === 'error' && s.notify_on_error) {
    const e = explainError(row.snap?.error || row.def.error)
    notify(
      frontmost,
      `${name} 下载失败`,
      e ? `${e.title}。${e.advice}` : '点开任务查看原因。',
      row.id,
    )
  }
  // 窗口不在前台时让任务栏图标闪起来：toast 会被自动收起，闪动的图标是第二次提醒。
  if (!frontmost && win && !win.isDestroyed()) win.flashFrame(true)
}

/**
 * 系统通知。窗口就在面前时不再弹 toast：用户正盯着进度条，跳出一条重复信息
 * 只是骚扰，而且 Windows 上连续 toast 还会进通知中心堆成一片。
 */
function notify(muted: boolean, title: string, body: string, taskId: string): void {
  if (muted) return
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body })
  n.on('click', () => {
    showWindow()
    win?.webContents.send(Ipc.TaskFocus, taskId)
  })
  n.show()
}

// ---------------------------------------------------------------- IPC 校验
//
// 渲染层的输入在这里全部当成不可信数据：类型不对就拒掉，而不是让主进程抛
// 未捕获异常（那会让整个调度器连同正在下载的任务一起没掉）。

const DOWNLOAD_URL_RE = /^(https?|ftp):\/\//i
/** 动作白名单：与 preload 暴露的 action() 以及 Manager.action 的分支一致。 */
const TASK_ACTIONS = new Set(['start', 'pause', 'resume', 'retry'])
const ALL_ACTIONS = new Set(['start', 'pause', 'clear-finished', 'retry-failed'])

function isId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 64
}

function err(error: string): { ok: false; error: string } {
  return { ok: false, error }
}

function wireIpc(): void {
  const m = manager
  const s = store

  // 返回 rows（定义 + 实时快照）而不是裸 listDefs：渲染进程靠它恢复断点进度
  ipcMain.handle(Ipc.TasksList, () => m.rows())

  ipcMain.handle(Ipc.TasksAdd, (_e, input) => {
    const raw = (input ?? {}) as Record<string, unknown>
    const url = typeof raw.url === 'string' ? raw.url.trim() : ''
    if (!DOWNLOAD_URL_RE.test(url)) return err('下载地址无效：需要 http(s):// 或 ftp:// 开头')
    const dest = typeof raw.dest === 'string' ? raw.dest.trim() : ''
    if (dest.length > 4000) return err('保存路径过长')
    const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, 500) : ''
    // 校验和要么当场判掉，要么原样落盘。放一串读不懂的字符进去，代价是
    // 十几个 GB 下完之后才报「校验失败」，那时用户已经不知道差异出在哪了。
    const checksum = normalizeChecksum(typeof raw.checksum === 'string' ? raw.checksum : '')
    if (checksum === null) {
      return err('校验和看不懂：需要 32 位（MD5）/ 40 位（SHA-1）/ 64 位（SHA-256）十六进制，或写成 sha256:… 的形式')
    }
    const threads = Number.isFinite(raw.threads) ? Number(raw.threads) : s.loadSettings().threads
    return { ok: true as const, ...m.add({ url, dest, threads, note, checksum }) }
  })

  // 移除任务。deleteFiles 由渲染层的勾选框决定：默认只删记录，磁盘上的东西
  // 一律不动（界面上就是这么承诺的）。用户明确要求连文件一起删时，
  // 只可能删这个任务自己的三个路径（成品 / .part / .part.meta），
  // 而删不掉的（被占用、没权限）必须回报原因，不能假装清理成功了。
  ipcMain.handle(Ipc.TasksRemove, async (_e, id: unknown, deleteFiles: unknown) => {
    if (!isId(id) || !m.has(id)) return err('任务不存在，可能已经被移除')
    const failures = await m.remove(id, deleteFiles === true)
    if (failures.length) return err(`任务已移除，但文件没删掉：${failures.join('；')}`)
    return { ok: true as const }
  })
  ipcMain.handle(Ipc.TasksClearFinished, async () => {
    await m.clearFinished()
    return { ok: true as const }
  })
  ipcMain.handle(Ipc.TaskAction, (_e, id: unknown, action: unknown) => {
    if (!isId(id) || !m.has(id)) return err('任务不存在，可能已经被移除')
    if (typeof action !== 'string' || !TASK_ACTIONS.has(action)) {
      return err(`不支持的操作：${String(action)}`)
    }
    m.action(id, action)
    return { ok: true as const }
  })
  ipcMain.handle(Ipc.TaskSetThreads, (_e, id: unknown, n: unknown) => {
    if (!isId(id) || !m.has(id)) return err('任务不存在，可能已经被移除')
    if (!Number.isFinite(n)) return err('线程数无效')
    m.setThreads(id, Number(n))
    return { ok: true as const }
  })
  // 事后补校验和：站点上的 md5 往往是用户下完才回去看到的。空串 = 取消校验。
  ipcMain.handle(Ipc.TaskSetChecksum, (_e, id: unknown, cs: unknown) => {
    if (!isId(id) || !m.has(id)) return err('任务不存在，可能已经被移除')
    const checksum = normalizeChecksum(typeof cs === 'string' ? cs : '')
    if (checksum === null) {
      return err('校验和看不懂：需要 32 位（MD5）/ 40 位（SHA-1）/ 64 位（SHA-256）十六进制，或写成 sha256:… 的形式')
    }
    m.setChecksum(id, checksum)
    return { ok: true as const }
  })
  ipcMain.handle(Ipc.ActionAll, async (_e, action: unknown) => {
    if (typeof action !== 'string' || !ALL_ACTIONS.has(action)) {
      return err(`不支持的操作：${String(action)}`)
    }
    await m.actionAll(action)
    return { ok: true as const }
  })

  ipcMain.handle(Ipc.SettingsGet, () => s.loadSettings())
  ipcMain.handle(Ipc.SettingsSave, async (_e, next) => {
    // 不直接把渲染层的对象写盘：normalizeSettings 会把非法字段回落到默认值。
    const saved = normalizeSettings(next)
    // 代理要「先确认能下发，再落盘」。顺序反了的话：盘里是新代理、Chromium 还在用
    // 旧代理，用户看到的就是「设置了代理但没生效」，而这正是最难自己查出来的一种。
    const bad = proxyFormatError(saved.proxy)
    if (bad) return err(bad)
    try {
      await applyChromiumProxy(saved.proxy)
    } catch (e) {
      return err(`代理没能下发到内置浏览器与站点解析：${e instanceof Error ? e.message : String(e)}`)
    }
    const before = s.loadSettings()
    s.saveSettings(saved)
    m.applySettings(saved)
    if (saved.dark !== before.dark) {
      win?.webContents.send(Ipc.ThemeChanged, saved.dark ? 'dark' : 'light')
    }
    // 防休眠开关改了要立刻生效，不能等下一秒的定时器——用户可能正把最后一个
    // 任务勾上，然后就走开了。
    syncKeepAwake()
    // 「启动时检查更新」开关：勾上就立刻检查，不用等下次启动；取消只是不再
    // 自动检查，已下载完成的更新仍然保留在「可安装」状态，不会丢。
    syncAutoCheck(saved.auto_update_check)
    return { ok: true as const, settings: saved }
  })

  // ------------------------------------------------------------ 应用更新
  //
  // 三个入口都直接转 updater.ts，错误一律回报可读原因。开发模式（未打包）
  // 下 check 返回拒绝，渲染层据此显示「当前已是最新」（避免开发机上来回弹错）。
  ipcMain.handle(Ipc.UpdateCheck, async () => {
    const r = await checkForUpdate()
    return r.ok ? { ok: true as const } : err(r.error ?? '检查更新失败')
  })
  ipcMain.handle(Ipc.UpdateInstall, async () => {
    const r = await installUpdate()
    return r.ok ? { ok: true as const } : err(r.error ?? '安装更新失败')
  })
  ipcMain.handle(Ipc.UpdateStatusGet, () => updateStatus())

  ipcMain.handle(Ipc.PickDir, () => {
    if (!win) return null
    const res = dialog.showOpenDialogSync(win, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: s.loadSettings().download_dir || undefined,
    })
    return res?.[0] ?? null
  })

  // 沿用 Electron 的约定：空串 = 成功，非空 = 失败原因。调用方自己判断。
  ipcMain.handle(Ipc.OpenPath, (_e, p: unknown) => {
    if (typeof p !== 'string' || !p) return '路径无效'
    return shell.openPath(p)
  })

  /**
   * 打开任务成品所在的文件夹。三种磁盘状态要分开处理，而且要回报结果：
   * 之前这个 handler 把所有失败都吃掉，用户点了图标什么都不发生，只能认为
   * 软件又坏了。dest 指向目录（老任务/手输的路径）时直接进那个目录，
   * 文件存在时高亮它本身——比打开父目录更符合「打开所在位置」的直觉。
   */
  ipcMain.handle(Ipc.OpenFolder, (_e, id: unknown) => {
    if (!isId(id)) return err('任务不存在')
    const d = m.listDefs().find((x) => x.id === id)
    if (!d || !d.dest) return err('任务不存在，可能已经被移除')
    const p = d.dest
    try {
      if (existsSync(p) && statSync(p).isDirectory()) {
        const why = shell.openPath(p)
        return why ? err(`打不开该文件夹：${why}`) : { ok: true as const }
      }
      if (existsSync(p)) {
        shell.showItemInFolder(p)
        return { ok: true as const }
      }
      const parent = dirname(p)
      if (!existsSync(parent)) return err(`保存目录还不存在：${parent}`)
      const why = shell.openPath(parent)
      return why ? err(`打不开该文件夹：${why}`) : { ok: true as const }
    } catch (e) {
      return err(`打开文件夹失败：${e instanceof Error ? e.message : String(e)}`)
    }
  })

  // 直接双击成品。失败原因（没这个扩展名的关联程序、文件还没下完、被占用）
  // 一律回报，不要静默。
  ipcMain.handle(Ipc.OpenFile, (_e, id: unknown) => {
    if (!isId(id)) return err('任务不存在')
    const d = m.listDefs().find((x) => x.id === id)
    if (!d || !d.dest) return err('任务不存在，可能已经被移除')
    if (!existsSync(d.dest)) return err('文件还没有下载完成，暂时打不开')
    const why = shell.openPath(d.dest)
    return why ? err(`打不开该文件：${why}`) : { ok: true as const }
  })

  ipcMain.handle(Ipc.ThemeGet, () => (s.loadSettings().dark ? 'dark' : 'light'))
  ipcMain.on(Ipc.WindowMinimize, () => win?.minimize())
  // 「关闭」有两种预期行为，所以做成设置：想让它退出的用户会觉得收进托盘是
  // 阴魂不散，想挂着下载的用户则最怕一点就整个退掉。默认收进托盘（下载不中断）。
  ipcMain.on(Ipc.WindowClose, () => {
    if (s.loadSettings().close_to_tray) win?.hide()
    else quit()
  })
}

// 浏览器扩展从不拉起 Electron（manifest 指向独立 Rust host），这里就是
// 正常启动路径。拿到单实例锁才进 whenReady。
if (gotSingleInstanceLock) {
  void app.whenReady().then(() => {
    store = new Store()
    // 打包应用首次启动就注册 native messaging 宿主（见 hostRegister.ts）：
    // 用户装好 FastDrop、打开一次、装上扩展，右键就能用，不需要任何手工步骤。
    registerNativeHost()
    const initialSettings = store.loadSettings()
    const initialDefs = store.loadTasks()
    manager = new Manager(
      initialSettings,
      (push) => win?.webContents.send(Ipc.TaskProgress, push),
      (tasks) => store.saveTasks(tasks),
      initialDefs,
    )
    // 代理必须在任何网络动作之前下发到 Chromium 侧（内嵌浏览器 + 站点抓取层）。
    // 保存设置时也会再来一次，所以这里是「冷启动对齐磁盘上的配置」。
    // 失败退回跟随系统代理：引擎侧会拿着同一份配置去下载，那时它会明确报错，
    // 不该让一个失效的代理地址把整个软件挡在启动门外。
    void applyChromiumProxy(initialSettings.proxy).catch((e: unknown) => {
      console.error('[net] 启动时下发代理失败，退回跟随系统代理：', e)
      void applyChromiumProxy('').catch((e2: unknown) => console.error('[net] 连系统代理也没配上：', e2))
    })
    // 终态 → 系统通知 + 任务栏闪动。挂在主进程而不是渲染层：窗口收进托盘时
    // 渲染层随时可能被丢弃，通知不能依赖它还活着。
    manager.onTerminal = notifyTerminal
    wireIpc()
    // 收件箱：浏览器扩展 / --inbox-add 投递下载链接的本地入口。随机端口 + token，
    // 见 inbox.ts。收件箱不决定「下载往哪存」——manager.add 会用当前下载目录。
    // 起不来（端口被占之类的偶发）就只记日志，不能让浏览器扩展把整个软件拖垮。
    void startInbox({
      addTask: (input) => {
        const m = manager
        const s = store
        if (!m || !s) return { ok: false, error: 'FastDrop 还没准备好，稍后再试' }
        const url = input.url.trim()
        const threads = input.threads ?? s.loadSettings().threads
        const outcome = m.add({ url, dest: '', threads, note: input.note ?? '' })
        return { ok: true, id: outcome.def.id, duplicate: outcome.duplicate }
      },
    }).catch((e: unknown) => {
      console.error('[inbox] 收件箱启动失败：', e)
    })
    // 游戏站：IPC + 捕获桥。依赖 Manager.add、当前设置（下载目录/线程数）
    wireSites({
      getWindow: () => win,
      addTask: (input) => manager.add(input),
      getDownloadDir: () => store.loadSettings().download_dir,
      getThreads: () => store.loadSettings().threads,
    })
    // 应用更新：状态机推给渲染层，注入窗口获取器。放在 wireIpc 之前不必要——
    // 更新检查是异步的，窗口创建在下面同一 tick，push 时判空即可。
    setupUpdater({ getWindow: () => win })
    createWindow()
    createTray()
    // 上次崩溃/强杀留下的未完成任务：重启后自动续传，不用用户手动点开始。
    manager.startQueued()
    // 启动后静默检查更新（设置里可关）。下载完成后会在界面上提示「重启安装」。
    if (initialSettings.auto_update_check) void checkForUpdate()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else showWindow()
    })
  })
}

// 关窗默认只藏到托盘，不退出（可由 close_to_tray 改成直接退出）：
// window-all-closed 挂空回调，把 Electron 默认的退出行为吃掉，保持进程和调度器
// 活着。真正的退出走托盘菜单 → quit()。
function quit(): void {
  if (trayTimer) {
    clearInterval(trayTimer)
    trayTimer = null
  }
  releaseKeepAwake()
  manager?.shutdown()
  tray?.destroy()
  tray = null
  app.quit()
}

app.on('window-all-closed', () => {
  // 故意什么都不做：等待托盘菜单退出。托盘图标此刻一定存在（createTray 用的是
  // 内嵌 data URL，不依赖资源文件），所以不会把用户困在无法退出的进程里。
})
app.on('before-quit', () => {
  // 退出可能不走托盘菜单（系统关机、app.quit 的其它路径），这里再兜一次：
  // 电源句柄和定时器不释放，进程死后系统仍然处于「不许休眠」状态。
  if (trayTimer) {
    clearInterval(trayTimer)
    trayTimer = null
  }
  releaseKeepAwake()
  manager?.shutdown()
})
