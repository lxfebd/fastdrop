/**
 * IPC 频道常量 + 渲染进程可见的 API 形状。主进程、preload、渲染进程三方共用同一份，
 * 避免手抄字符串导致的隐形错配。
 *
 * 注意 listTasks 返回的是 TaskRow（定义 + 实时快照），不是裸 TaskDef：
 * 渲染进程兜底轮询时如果只拿定义，重启后就看不到已下载任务的断点进度了。
 *
 * 写操作一律返回 ActionResult / AddResult，而不是 undefined：主进程拒绝时
 * 渲染层必须拿到可读原因，不能把失败显示成成功。
 */
import type {
  ActionResult,
  AddResult,
  SaveSettingsResult,
  Settings,
  TaskProgressPush,
  TaskRow,
  UpdateStatus,
} from './types'
import type { Mirror, ResolveOutcome, SiteInfo, SiteMirrorOutcome, SiteSearchOutcome } from './sites'

export const Ipc = {
  // 渲染进程 → 主进程
  TasksList: 'tasks:list',
  TasksAdd: 'tasks:add',
  TasksRemove: 'tasks:remove',
  TasksClearFinished: 'tasks:clear-finished',
  TaskAction: 'task:action',
  TaskSetThreads: 'task:set-threads',
  TaskSetChecksum: 'task:set-checksum',
  ActionAll: 'action:all',
  SettingsGet: 'settings:get',
  SettingsSave: 'settings:save',
  PickDir: 'dialog:pick-dir',
  OpenPath: 'shell:open-path',
  OpenFolder: 'shell:open-folder',
  OpenFile: 'shell:open-file',
  ThemeGet: 'theme:get',
  WindowMinimize: 'win:minimize',
  WindowClose: 'win:close',
  /** 渲染层挂载完成 / 启动期报错的上报。主进程拿它当看门狗的信号。 */
  UiReady: 'ui:ready',
  UiBootError: 'ui:boot-error',

  // 应用更新
  UpdateCheck: 'update:check',
  UpdateInstall: 'update:install',
  UpdateStatusGet: 'update:status',

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
  SiteDownload: 'push:site-download',
  /** 点系统通知：让渲染进程选中并滚动到那条任务 */
  TaskFocus: 'push:task-focus',
  /** 应用更新状态机的实时推送（下载进度 / 出错 / 可安装） */
  UpdateStatus: 'push:update-status',
} as const

/**
 * 游戏站下载的统一推送。三种结局要分开播报，因为它们的用户动作完全不同：
 *   captured —— 公开直链，已交给 FastDrop 引擎（渲染层建任务、列表里能看进度）
 *   browser  —— 需要浏览器会话，Chromium 正在用当前 Cookie 下载（引擎帮不上忙）
 *   done     —— 上面第二条的收尾，告诉用户文件落在哪、成没成
 * 以前只有 captured 一条路：会话链接也被摘成裸 URL 喂给引擎，界面显示「已添加」，
 * 实际必然 403 失败，用户只能回去复制下载链接。
 */
export type SiteDownloadPush =
  | { kind: 'captured'; url: string; filename?: string; siteId?: string }
  | { kind: 'browser'; filename: string; dest: string }
  | { kind: 'done'; filename: string; dest: string; ok: boolean; error?: string }

export interface FastDropApi {
  listTasks(): Promise<TaskRow[]>
  /**
   * 新建任务。checksum 是给引擎做完下载后核对用的，形如 `sha256:<64 位十六进制>`，
   * 也可以只贴一串裸十六进制（按长度自动认 md5 / sha1 / sha256）；留空表示不校验。
   * 主进程读不懂会直接退回错误，不会先下再报错。
   */
  addTask(input: {
    url: string
    dest: string
    threads: number
    note?: string
    checksum?: string
  }): Promise<AddResult>
  /**
   * 移除任务。deleteFiles=true 时连同已落盘的成品与断点（.part / .part.meta）
   * 一起删掉；默认只删记录。删文件失败必须回报，不能静默——用户据此判断
   * 磁盘上还剩多少东西。
   */
  removeTask(id: string, deleteFiles?: boolean): Promise<ActionResult>
  clearFinished(): Promise<ActionResult>
  // 'open' 不在这个集合里：打开文件/文件夹要走 shell，主进程单独挂了频道。
  // 'retry' = 放弃已有进度从头再下（失败重试、以及已完成文件的「重新下载」）。
  // 移除/取消不在这里：删除走 removeTask（要带「是否连文件一起删」），
  // 停止走 pause，主进程不再接受 'delete' / 'cancel' 两个旧名字。
  action(id: string, action: 'start' | 'pause' | 'resume' | 'retry'): Promise<ActionResult>
  setThreads(id: string, n: number): Promise<ActionResult>
  /**
   * 设置/修改某个任务的期望校验和。传空串表示不校验。
   * 下一轮下载生效（正在跑的这一轮，引擎已经带着旧值在下载了）。
   */
  setChecksum(id: string, checksum: string): Promise<ActionResult>
  actionAll(action: 'start' | 'pause' | 'clear-finished' | 'retry-failed'): Promise<ActionResult>
  getSettings(): Promise<Settings>
  /** 返回主进程实际落盘的设置（非法字段已被回落到默认值），UI 要采用它而不是自己那份。
   *  代理非法时返回 ok:false + 原因：不能一边写盘一边让 Chromium 侧保持旧配置。 */
  saveSettings(s: Settings): Promise<SaveSettingsResult>
  pickDir(): Promise<string | null>
  /** 返回空串表示成功；非空是 shell 给出的失败原因（沿用 Electron 的约定）。 */
  openPath(p: string): Promise<string>
  /** 打开任务成品所在的文件夹（失败要回报，不能点了一下没反应）。 */
  openFolder(id: string): Promise<ActionResult>
  /** 用系统关联程序直接打开成品文件。 */
  openFile(id: string): Promise<ActionResult>
  getTheme(): Promise<'light' | 'dark'>
  minimize(): Promise<void>
  close(): Promise<void>
  /**
   * 界面向主进程报告自己活过来了（或者压根没活过来）。
   *
   * ready 是判据：主进程那边有个加载看门狗（时限见 main/uiRescue.ts 的 WATCHDOG_MS），
   * 等不到就把窗口换成带原因和出口按钮的兜底页。error 只负责让那句原因从
   * 「没等到」变成「错在某某处」——preload 没挂上时连 error 都发不出去，
   * 所以看门狗不能只依赖它。
   */
  uiBoot: {
    ready(): void
    error(detail: string): void
  }
  onTaskProgress(cb: (p: TaskProgressPush) => void): () => void
  onThemeChanged(cb: (t: 'light' | 'dark') => void): () => void
  /** 点系统通知后聚焦并选中某个任务。 */
  onTaskFocus(cb: (id: string) => void): () => void

  // 游戏站
  sitesList(): Promise<SiteInfo[]>
  sitesSearch(siteId: string, keyword: string): Promise<SiteSearchOutcome>
  sitesMirrors(siteId: string, detailUrl: string): Promise<SiteMirrorOutcome>
  sitesResolve(mirror: Mirror): Promise<ResolveOutcome>
  /** 以给定的 URL/文件名直接建任务（捕获桥/直链下载用）。 */
  sitesAddTask(input: { url: string; filename?: string }): Promise<AddResult>
  /** 在系统浏览器里打开链接（webview 里的网盘链接）。 */
  webviewOpenExternal(url: string): Promise<void>
  /** 游戏站下载的三条去向（公开直链进引擎 / 会话链接走浏览器 / 其收尾）。 */
  onSiteDownload(cb: (p: SiteDownloadPush) => void): () => void

  // 应用更新
  /** 立即检查更新（开发模式下恒为「已是最新」）。 */
  checkUpdate(): Promise<ActionResult>
  /** 下载完成后触发「重启并安装」。没有可下载的更新时拒绝。 */
  installUpdate(): Promise<ActionResult>
  /** 查询当前更新状态（重开设置弹窗时恢复上一次的状态条）。 */
  updateStatus(): Promise<UpdateStatus>
  /** 更新状态机的实时推送：下载进度、出错、可安装等。 */
  onUpdateStatus(cb: (s: UpdateStatus) => void): () => void
}
