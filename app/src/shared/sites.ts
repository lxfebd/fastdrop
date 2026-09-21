/**
 * 游戏站集成相关的共享类型。主进程（站点适配器）、preload、渲染进程
 * （GameSites.vue）三方共用，避免手抄字符串错配。
 *
 * 站点内容解析是「尽力而为」的：这些站点的 HTML 是动态生成的，选择器
 * 可能随改版失效。因此这里的类型刻意宽松——解析失败时返回 message 而
 * 不抛异常，UI 按 message 展示原因。
 */

/**
 * 游戏页签 webview 与主进程抓取层共用的会话分区。
 *
 * 必须是同一个常量而不是两边各写一遍字面量：抓取层复用的正是用户在这个分区里
 * 的登录态，写错一个字就会出现「浏览器里能看到、解析层却被判成需要登录」。
 */
export const GAMESITES_PARTITION = 'persist:gamesites'

/** 一个已注册的站点。id 同时是侧栏切换键和搜索路由的键。 */
export interface SiteInfo {
  id: string
  name: string
  /** 站点主页，webview 初始加载的就是它 */
  home: string
  /** 搜索关键词占位符，如「游戏名 / 关键词」 */
  searchPlaceholder: string
}

/** 搜索结果中的一条游戏。 */
export interface SiteSearchResult {
  siteId: string
  title: string
  url: string
  /** 列表页能看到的信息（大小/日期/平台），没有就空字符串 */
  info?: string
}

/** 下载镜像类型。网盘类只能浏览器手动，直链类可以直接喂给 FastDrop 引擎。 */
export type MirrorKind = 'pan' | 'gofile' | 'direct' | 'cloudreve' | 'torrent' | 'page'

/** 一条下载镜像。来自详情页解析或嵌套网的解析。 */
export interface Mirror {
  kind: MirrorKind
  name: string
  url: string
  /** 提取码 / 解压密码 / 等补充说明 */
  note?: string
}

/** 一次站点搜索的完整结果。 */
export interface SiteSearchOutcome {
  ok: boolean
  siteId: string
  results?: SiteSearchResult[]
  /** ok=false 时的原因，或搜索无结果时的提示 */
  message?: string
}

/** 详情页解析出来的下载镜像列表。 */
export interface SiteMirrorOutcome {
  ok: boolean
  siteId: string
  title?: string
  mirrors?: Mirror[]
  message?: string
}

/** 解析出的单个可下载文件。 */
export interface ResolvedFile {
  url: string
  filename: string
  size?: number
}

/** 把某条镜像解析成可下载直链的结果。 */
export interface ResolveOutcome {
  ok: boolean
  /** 单个文件的直链（files 为空时用） */
  url?: string
  filename?: string
  /** 单个文件的大小说明（字节） */
  size?: number
  /** 批量文件：一个分享里有多个文件（例如 RAR 分卷）时的全部直链 */
  files?: ResolvedFile[]
  mirrors?: Mirror[]
  message?: string
  /**
   * 分享页里有多少文件没变成下载任务（超出单次解析上限、或换直链失败）。
   * 渲染层靠这个数字决定「要不要把分享页摊给用户继续挑」，
   * 不能靠读 message 里的中文措辞。
   */
  missing?: number
}