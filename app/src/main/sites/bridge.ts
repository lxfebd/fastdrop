/**
 * 游戏站的主进程接线：IPC 处理 + 下载捕获桥。
 *
 * - sites:* 频道把解析器能力暴露给渲染层；
 * - 捕获桥监听 webview（partition=persist:gamesites）会话的 will-download：
 *   用户在页面里点下载、会话判定为「文件下载」时，取消 Electron 默认保存，
 *   把 URL 推给渲染层弹「添加到 FastDrop」。这样 gofile 或其他任何真实文件
 *   下载都自动进 FastDrop；网盘链接是页面跳转，不会触发下载，用户照常处理。
 */
import {
  ipcMain,
  session,
  shell,
  type BrowserWindow,
  type DownloadItem,
  type WebContents,
} from 'electron'
import { join } from 'node:path'
import type { Mirror } from '../../shared/sites'
import { Ipc } from '../../shared/ipc'
import { listSites, mirrorsOf, searchSite } from './registry'
import { resolveMirror } from './resolver'
import { defaultDownloadDir } from '../store'

/** webview 专用会话分区：登录状态跨重启保持 */
export const WEBVIEW_PARTITION = 'persist:gamesites'

export interface BridgeDeps {
  /** 拿主窗口，用来推送事件 */
  getWindow: () => BrowserWindow | null
  /** 复用 Manager.add 建任务 */
  addTask: (input: { url: string; dest: string; threads?: number; note?: string }) => unknown
  /** 渲染层当前选中的下载目录 */
  getDownloadDir: () => string
  /** 渲染层当前线程数设置 */
  getThreads: () => number
}

export function wireSites(deps: BridgeDeps): () => void {
  ipcMain.handle(Ipc.SitesList, () => listSites())
  ipcMain.handle(Ipc.SitesSearch, (_e, siteId: string, keyword: string) =>
    searchSite(siteId, keyword),
  )
  ipcMain.handle(Ipc.SitesMirrors, (_e, siteId: string, detailUrl: string) =>
    mirrorsOf(siteId, detailUrl),
  )
  ipcMain.handle(Ipc.SitesResolve, (_e, mirror: Mirror) => resolveMirror(mirror))

  ipcMain.handle(Ipc.SitesAddTask, (_e, input: { url: string; filename?: string }) => {
    const url = input.url.trim()
    if (!/^https?:\/\//i.test(url)) throw new Error('不是有效的下载地址')
    let dest = deps.getDownloadDir() || defaultDownloadDir()
    if (input.filename) dest = join(dest, sanitizeName(input.filename))
    return deps.addTask({ url, dest, threads: deps.getThreads(), note: '游戏站：点击下载' })
  })

  ipcMain.handle(Ipc.WebviewOpenExternal, (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  // ----------------------------------------------------------- 捕获桥

  const ses = session.fromPartition(WEBVIEW_PARTITION)
  const onWillDownload = (
    _e: { preventDefault: () => void },
    item: DownloadItem,
    _webContents: WebContents,
  ): void => {
    // 先拦下默认的「另存为」/直接落盘，避免用户两边都存一份
    if (item.getState() === 'progressing') item.cancel()
    const url = item.getURL()
    if (!url) return
    const win = deps.getWindow()
    win?.webContents.send(Ipc.DownloadCaptured, {
      url,
      filename: item.getFilename() || undefined,
      siteId: matchSiteId(url),
    })
  }
  ses.on('will-download', onWillDownload)

  return () => {
    ses.removeListener('will-download', onWillDownload)
    ipcMain.removeHandler(Ipc.SitesList)
    ipcMain.removeHandler(Ipc.SitesSearch)
    ipcMain.removeHandler(Ipc.SitesMirrors)
    ipcMain.removeHandler(Ipc.SitesResolve)
    ipcMain.removeHandler(Ipc.SitesAddTask)
    ipcMain.removeHandler(Ipc.WebviewOpenExternal)
  }
}

/** 把 URL 映射到的站点 id，用于渲染层提示「来自哪个站」。 */
function matchSiteId(url: string): string | undefined {
  try {
    const host = new URL(url).hostname
    if (host === 'gamer520.com' || host.endsWith('.gamer520.com')) return 'gamer520'
    if (host === 'nekogal.com' || host.endsWith('.nekogal.com')) return 'nekogal'
    if (host === 'playzip.com' || host.endsWith('.playzip.com')) return 'playzip'
  } catch {
    // ignore
  }
  return undefined
}

/** 文件名里不允许出现路径分隔符，防止恶意文件名写出去。 */
function sanitizeName(name: string): string {
  return name.replace(/[\\/]/g, '_').replace(/[<>:"|?*]/g, '_').trim() || 'download'
}