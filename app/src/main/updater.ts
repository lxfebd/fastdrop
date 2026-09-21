/**
 * 应用内自动更新（electron-updater）。
 *
 * 职责：把 electron-updater 的事件流翻译成渲染层能直接显示的 UpdateStatus
 * 状态机，并暴露 check / install 两个 IPC 入口。窗口藏在托盘里时更新照常推进——
 * 下载进度和「已就绪，可安装」都推给渲染层（推送时判空，窗口不存在就丢）。
 *
 * 只在打包环境启用：开发模式没有 latest.yml 也没有可写的安装目录，检查只会
 * 得到「失败」，不如直接告诉渲染层当前就是最新版。
 *
 * 流程：checkForUpdates() 发现新版 → autoDownload=true 自动静默下载 →
 * download-progress 持续推进度 → update-downloaded 等用户点「重启安装」，
 * 或者下次退出应用时自动安装（autoInstallOnAppQuit 默认 true）。
 */
import { autoUpdater } from 'electron-updater'
import type { UpdateInfo } from 'electron-updater'
import type { ProgressInfo } from 'builder-util-runtime'
import type { UpdateStatus } from '../shared/types'
import { Ipc } from '../shared/ipc'

let getWin: (() => Electron.BrowserWindow | null) | null = null

/** 状态机当前快照。渲染层随时可以查询（updateStatus()），不依赖它记得住推送。 */
let current: UpdateStatus = { phase: 'idle' }

function set(s: UpdateStatus): void {
  // 整对象替换：新一轮流程（checking/downloading/…）发出的状态下不携带 error，
  // 上一轮的失败提示自然被清掉，不会在成功界面里残留一条旧报错。
  current = s
  push()
}

function push(): void {
  const w = getWin?.()
  if (w && !w.isDestroyed()) w.webContents.send(Ipc.UpdateStatus, current)
}

/** electron-updater 的异常信息是给开发者看的（含模块内部栈），界面得翻成人话。 */
function humanError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  // 常见失败（无网络、Release 里还没有更新元数据）的报错信息又长又散，
  // 保留前面一句可读的即可。
  return msg.split('\n')[0] || '未知错误'
}

/** 接线 + 状态机翻译。必须在 app ready 之后、任何网络动作之前调用一次。 */
export function setupUpdater(opts: { getWindow: () => Electron.BrowserWindow | null }): void {
  getWin = opts.getWindow

  autoUpdater.autoDownload = true
  // 用户点了「重启安装」才立即装；没点的话，退出应用时再顺手装上。
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => set({ phase: 'checking' }))
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    // autoDownload=true：到这里下载已自动开始，状态条直接显示「发现新版 + 下载中」。
    set({ phase: 'downloading', version: info.version, progress: 0, transferred: 0, total: 0 })
  })
  autoUpdater.on('update-not-available', () => set({ phase: 'idle' }))
  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    set({
      phase: 'downloading',
      progress: p.percent / 100,
      transferred: p.transferred,
      total: p.total,
    })
  })
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    set({ phase: 'downloaded', version: info.version, progress: 1 })
  })
  autoUpdater.on('error', (e: unknown) => {
    set({ phase: 'idle', error: humanError(e) })
  })
}

/** 立即检查（自动下载交给 autoDownload）。开发模式直接拒绝。 */
export async function checkForUpdate(): Promise<{ ok: boolean; error?: string }> {
  if (!autoUpdater.isUpdaterActive()) {
    return { ok: false, error: '当前是开发版本，无法检查更新' }
  }
  try {
    await autoUpdater.checkForUpdates()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: `检查更新失败：${humanError(e)}` }
  }
}

/** 重启并安装。electron-updater 只在下载完成后才允许这一动作。 */
export async function installUpdate(): Promise<{ ok: boolean; error?: string }> {
  if (current.phase !== 'downloaded') {
    return { ok: false, error: '还没有下载完成的更新可安装' }
  }
  set({ phase: 'installing' })
  // quitAndInstall 会先关掉所有窗口再装，返回 Promise 没有意义，直接放行。
  autoUpdater.quitAndInstall()
  return { ok: true }
}

export function updateStatus(): UpdateStatus {
  return current
}

/**
 * 「启动时检查更新」开关生效的入口。设置保存时由主进程调用：
 * 关 → 随便；开 → 立即发起一轮检查（下载自动跟进）。
 */
export function syncAutoCheck(autoCheck: boolean): void {
  if (!autoUpdater.isUpdaterActive()) return
  if (autoCheck) void checkForUpdate()
}