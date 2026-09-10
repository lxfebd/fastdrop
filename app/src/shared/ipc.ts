/**
 * IPC 频道常量 + 渲染进程可见的 API 形状。主进程、preload、渲染进程三方共用同一份，
 * 避免手抄字符串导致的隐形错配。
 *
 * 注意 listTasks 返回的是 TaskRow（定义 + 实时快照），不是裸 TaskDef：
 * 渲染进程每 1s 轮询一次，如果只拿定义，重启后就看不到已下载任务的断点进度了。
 */
import type { Settings, TaskDef, TaskProgressPush, TaskRow } from './types'
import type { Mirror, ResolveOutcome, SiteInfo, SiteMirrorOutcome, SiteSearchOutcome } from './sites'

export const Ipc = {
  // 渲染进程 → 主进程
  TasksList: 'tasks:list',
  TasksAdd: 'tasks:add',
  TasksRemove: 'tasks:remove',
  TasksClearFinished: 'tasks:clear-finished',
  TaskAction: 'task:action',
  TaskSetThreads: 'task:set-threads',
  ActionAll: 'action:all',
  SettingsGet: 'settings:get',
  SettingsSave: 'settings:save',
  PickDir: 'dialog:pick-dir',
  OpenPath: 'shell:open-path',
  OpenFolder: 'shell:open-folder',
  ThemeGet: 'theme:get',
  WindowMinimize: 'win:minimize',
  WindowClose: 'win:close',

  // 游戏站
  SitesList: 'sites:list',
  SitesSearch: 'sites:search',
  SitesMirrors: 'sites:mirrors',
  SitesResolve: 'sites:resolve',
  SitesAddTask: 'sites:add-task',
  WebviewOpenExternal: 'webview:open-external',

  // 主进程 → 渲染进程（推送）
  TaskProgress: 'push:task-progress',
  SettingsChanged: 'push:settings-changed',
  ThemeChanged: 'push:theme-changed',
  DownloadCaptured: 'push:download-captured',
} as const

/** 捕获桥把「浏览器里点下载的文件」推给渲染层的形状。 */
export interface CapturedDownload {
  url: string
  filename?: string
  /** 命中的站点 id，用于精确匹配 */
  siteId?: string
}

export interface FastDropApi {
  listTasks(): Promise<TaskRow[]>
  addTask(input: { url: string; dest: string; threads: number; note?: string }): Promise<TaskDef>
  removeTask(id: string): Promise<void>
  clearFinished(): Promise<void>
  // 'open' 不在这个集合里：打开文件夹要走 shell，主进程单独挂了 OpenFolder 频道。
  action(
    id: string,
    action: 'start' | 'pause' | 'resume' | 'delete' | 'cancel',
  ): Promise<void>
  setThreads(id: string, n: number): Promise<void>
  actionAll(action: 'start' | 'pause' | 'clear-finished'): Promise<void>
  getSettings(): Promise<Settings>
  saveSettings(s: Settings): Promise<void>
  pickDir(): Promise<string | null>
  openPath(p: string): Promise<void>
  openFolder(id: string): Promise<void>
  getTheme(): Promise<'light' | 'dark'>
  minimize(): Promise<void>
  close(): Promise<void>
  onTaskProgress(cb: (p: TaskProgressPush) => void): () => void
  onThemeChanged(cb: (t: 'light' | 'dark') => void): () => void

  // 游戏站
  sitesList(): Promise<SiteInfo[]>
  sitesSearch(siteId: string, keyword: string): Promise<SiteSearchOutcome>
  sitesMirrors(siteId: string, detailUrl: string): Promise<SiteMirrorOutcome>
  sitesResolve(mirror: Mirror): Promise<ResolveOutcome>
  /** 以给定的 URL/文件名直接建任务（捕获桥/直链下载用）。 */
  sitesAddTask(input: { url: string; filename?: string }): Promise<TaskDef>
  /** 在系统浏览器里打开链接（webview 里的网盘链接）。 */
  webviewOpenExternal(url: string): Promise<void>
  onDownloadCaptured(cb: (d: CapturedDownload) => void): () => void
}
