/**
 * 游戏站的主进程接线：IPC 处理 + 下载捕获桥。
 *
 * - sites:* 频道把解析器能力暴露给渲染层；
 * - 捕获桥监听 webview（partition=persist:gamesites）会话的 will-download：
 *   用户在页面里点下载时自动接管，不需要他手动复制下载链接。
 *
 * 捕获桥有两条出口，区别在于「这条链接离得开浏览器会话吗」：
 *   1. 匿名可下的公开直链 → 取消浏览器下载，交给 Rust 引擎分段并发；
 *   2. 需要 Cookie/Referer 的会话链接 → 让 Chromium 用当前会话继续下，
 *      只是把保存位置钉到下载目录。
 * 以前只有第 1 条：will-download 里无条件 item.cancel() 后把裸 URL 推给引擎，
 * 而引擎拿不到 webview 会话里的 Cookie，于是页面里明明下得动的东西进了
 * FastDrop 就变成 http 403（实测：站点服务器记到 3 次 denied-no-cookie）。
 */
import {
  ipcMain,
  session,
  shell,
  type BrowserWindow,
  type DownloadItem,
  type WebContents,
} from 'electron'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Mirror } from '../../shared/sites'
import { GAMESITES_PARTITION } from '../../shared/sites'
import type { AddOutcome } from '../manager'
import type { SiteDownloadPush } from '../../shared/ipc'
import { Ipc } from '../../shared/ipc'
import { listSites, mirrorsOf, searchSite, siteIdForUrl } from './registry'
import { resolveMirror } from './resolver'
import { probeHead } from './http'
import { defaultDownloadDir, safeFileName, uniquePath } from '../store'

export interface BridgeDeps {
  /** 拿主窗口，用来推送事件 */
  getWindow: () => BrowserWindow | null
  /** 复用 Manager.add 建任务 */
  addTask: (input: {
    url: string
    dest: string
    threads?: number
    note?: string
  }) => AddOutcome
  /** 渲染层当前选中的下载目录 */
  getDownloadDir: () => string
  /** 渲染层当前线程数设置 */
  getThreads: () => number
}

export function wireSites(deps: BridgeDeps): () => void {
  const pushSiteDownload = (p: SiteDownloadPush): void => {
    deps.getWindow()?.webContents.send(Ipc.SiteDownload, p)
  }

  ipcMain.handle(Ipc.SitesList, () => listSites())
  ipcMain.handle(Ipc.SitesSearch, (_e, siteId: string, keyword: string) =>
    searchSite(siteId, keyword),
  )
  ipcMain.handle(Ipc.SitesMirrors, (_e, siteId: string, detailUrl: string) =>
    mirrorsOf(siteId, detailUrl),
  )
  ipcMain.handle(Ipc.SitesResolve, (_e, mirror: Mirror) => resolveMirror(mirror))

  ipcMain.handle(Ipc.SitesAddTask, (_e, input: { url: string; filename?: string }) => {
    const url = typeof input?.url === 'string' ? input.url.trim() : ''
    if (!/^https?:\/\//i.test(url)) return { ok: false as const, error: '不是有效的下载地址' }
    const name = input.filename ? safeFileName(input.filename) : ''
    const dir = deps.getDownloadDir() || defaultDownloadDir()
    const dest = uniquePath(name ? join(dir, name) : dir)
    return { ok: true as const, ...deps.addTask({ url, dest, threads: deps.getThreads(), note: '游戏站' }) }
  })

  ipcMain.handle(Ipc.WebviewOpenExternal, (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  // ----------------------------------------------------------- 捕获桥

  const ses = session.fromPartition(GAMESITES_PARTITION)
  const onWillDownload = (
    _e: { preventDefault: () => void },
    item: DownloadItem,
    _webContents: WebContents,
  ): void => {
    const url = item.getURL()
    if (!url || !/^https?:\/\//i.test(url)) return
    const filename = safeFileName(item.getFilename() || guessName(url) || '')
    const dest = browserDest(deps.getDownloadDir(), filename)
    // 先钉死保存路径：不设的话 Electron 会弹「另存为」，用户就得手动确认每一次。
    item.setSavePath(dest)
    // 再暂停：给我们一个从容判断的时间窗，且不会先写半截文件。
    // 不 pause 直接异步决策，探测回来时小文件可能已经下完，那时 cancel 已无意义。
    item.pause()
    void decide(url, filename, dest, item, pushSiteDownload)
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

/**
 * 探测结果决定走哪条出口。
 *
 * 探测走抓取层的匿名会话（sessionKind:'anon'）：Chromium 的 webRequest/分区会话会
 * 自动带上 persist:gamesites 的 Cookie，用浏览器自身去"匿名"探测必然得到"能下"，
 * 那就等于没探。抓取层现在虽然也换成 Chromium 栈，但匿名那条走的是 defaultSession
 * 且 useSessionCookies:false，实测（探针 fd_probe4 C1）服务端收到的是无 Cookie 请求。
 */
async function decide(
  url: string,
  filename: string,
  dest: string,
  item: DownloadItem,
  push: (p: SiteDownloadPush) => void,
): Promise<void> {
  const publicLink = await isPubliclyDownloadable(url)
  // 探测期间用户可能已经关了窗口，或者页面自己取消了下载
  if (isSettled(item)) return

  if (publicLink) {
    item.cancel() // 交给引擎分段下，浏览器不留副本
    push({ kind: 'captured', url, filename, siteId: siteIdForUrl(url) })
    return
  }

  // 会话链接：把下载还给浏览器，它手里有 Cookie。
  item.once('done', (_e, state) => {
    if (state === 'completed') {
      push({ kind: 'done', filename, dest, ok: true })
    } else {
      push({ kind: 'done', filename, dest, ok: false, error: `浏览器下载${state === 'cancelled' ? '被取消' : '中断'}` })
    }
  })
  // 先告诉渲染层「这条我们用浏览器接着下」，用户才知道点了有用
  push({ kind: 'browser', filename, dest })
  try {
    item.resume()
  } catch {
    // pause/resume 不支持时（极少数服务端行为）退回默认保存路径继续下
  }
}

/**
 * 这条下载是否已经「落定」（下完 / 中断 / 取消），或者 item 已经随 webContents
 * 一起销毁了。探测最多花 6 秒，这期间窗口可能已关、页面可能自己撤了下载。
 *
 * 用黑名单而不是 `!== 'progressing'`：pause 之后 Chromium 的 state 在个别版本
 * 上报的并一定是 progressing 文案，白名单会让决策整个跳过、下载永远停在半路。
 */
function isSettled(item: DownloadItem): boolean {
  try {
    const st = item.getState()
    return st === 'completed' || st === 'interrupted'
  } catch {
    return true
  }
}

/** 探测失败一律按「不是公开直链」处理：宁可走浏览器，也不要下一个必死的任务。 */
async function isPubliclyDownloadable(url: string): Promise<boolean> {
  try {
    const r = await probeHead(url, {
      headers: { range: 'bytes=0-0' },
      sessionKind: 'anon',
      timeoutMs: 6000,
    })
    if (!r.ok) return false
    try {
      if (new URL(r.url).origin !== new URL(url).origin) return false
    } catch {
      return false
    }
    // 返回 HTML 说明被弹回登录页/中间页，不是文件
    if (r.contentType.toLowerCase().includes('text/html')) return false
    return true
  } catch {
    return false
  }
}

/** 浏览器出口的目标路径：目录不存在要先建好，否则 Chromium 直接 interrupted。 */
function browserDest(dir: string, filename: string): string {
  const base = dir || defaultDownloadDir()
  const dest = uniquePath(join(base, filename))
  try {
    mkdirSync(dirname(dest), { recursive: true })
  } catch {
    // 建不出来就让 Chromium 报错，别在这里吞掉
  }
  return dest
}

/** 服务端没给文件名时（少数情况）从 URL 猜一个。 */
function guessName(url: string): string {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).pop() ?? ''
  } catch {
    return ''
  }
}
