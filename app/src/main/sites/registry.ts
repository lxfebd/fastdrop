/**
 * 游戏站注册表。新增站点只需在这里加一条（含归属域名 hosts）+ 在 sites/ 下加对应的
 * 解析器（实现 search/mirrors 两个函数），主进程与渲染层不需要再改。
 */
import type { SiteInfo, SiteMirrorOutcome, SiteSearchOutcome } from '../../shared/sites'
import * as gamer520 from './gamer520'
import * as nekogal from './nekogal'
import * as playzip from './playzip'

export interface SiteAdapter {
  search(keyword: string): Promise<SiteSearchOutcome>
  mirrors(detailUrl: string): Promise<SiteMirrorOutcome>
}

interface SiteRegistration extends SiteInfo {
  adapter: SiteAdapter
  /**
   * 归属域名（写裸域，www./pan. 这类子域自动算进来）。
   * 内嵌浏览器捕获到的下载靠它认「这条是哪一站给的」，所以列的是站点的全部域名、
   * 不只是首页那一个：gamer520 的镜像页在 gamers520.com（少一个 r），
   * 以前 matchSiteId 只认首页域名，从镜像页抓下来的文件就没有来源标注。
   */
  hosts: string[]
}

const SITES: SiteRegistration[] = [
  {
    id: 'gamer520',
    name: 'Gamer520',
    home: 'https://www.gamer520.com',
    searchPlaceholder: '搜索 PC / Switch 游戏…',
    hosts: ['gamer520.com', 'gamers520.com'],
    adapter: gamer520,
  },
  {
    id: 'nekogal',
    name: 'NekoGAL',
    home: 'https://www.nekogal.com',
    searchPlaceholder: '搜索 Galgame…',
    hosts: ['nekogal.com', 'nekogal.top'],
    adapter: nekogal,
  },
  {
    id: 'playzip',
    name: 'PlayZip',
    home: 'https://playzip.com',
    searchPlaceholder: '搜索游戏…',
    hosts: ['playzip.com'],
    adapter: playzip,
  },
]

/**
 * 这条 URL 属于哪一站。认不出返回 undefined（不硬编一个站给用户看）。
 *
 * 注册表里加一站只需要补 hosts，不用再记着去 bridge 里补一条 if——
 * 那份重复正是 gamers520.com 被漏掉的原因。
 */
export function siteIdForUrl(url: string): string | undefined {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
  return SITES.find((s) => s.hosts.some((h) => host === h || host.endsWith(`.${h}`)))?.id
}

/** 渲染进程展示用的站点元信息（不含 adapter）。 */
export function listSites(): SiteInfo[] {
  return SITES.map(({ id, name, home, searchPlaceholder }) => ({ id, name, home, searchPlaceholder }))
}

export function getSite(id: string): SiteRegistration | undefined {
  return SITES.find((s) => s.id === id)
}

/**
 * 单站搜索的总预算。
 *
 * 站点适配器内部会重试（`withRetry` 三次 + 指数退避），单次请求又封顶 15 秒，
 * 一条搜索最坏能拖到 46 秒；而渲染层以前是「所有站一起结项」，于是
 * 一个站卡住 = 整屏没有结果，用户看到的就是"每次搜索都得白等十几秒"。
 * 现在每站各拿一份预算：到点先返回这一次的超时原因，其余站照常增量出结果。
 *
 * 取 20 秒而不是更小：一次正常的慢请求最长就是 15 秒超时，卡在这里再砍
 * 会把「慢但确实能通」的站点一起判死。
 */
const SEARCH_BUDGET_MS = 20000

/** 带默认站的搜索调用，省去调用方判空。 */
export async function searchSite(id: string, keyword: string): Promise<SiteSearchOutcome> {
  const site = getSite(id)
  if (!site) return { ok: false, siteId: id, message: `未知站点：${id}` }
  let timer: ReturnType<typeof setTimeout> | undefined
  // 输掉这场比赛的 Promise 还在后台跑，它若稍后 reject 就是未捕获拒绝，
  // 所以先把 rejection 收敛成一个正常返回值再进 race。
  const attempt = site.adapter.search(keyword).catch(
    (e: unknown): SiteSearchOutcome => ({
      ok: false,
      siteId: id,
      message: `${site.name} 搜索异常：${e instanceof Error ? e.message : String(e)}`,
    }),
  )
  const budget = new Promise<SiteSearchOutcome>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          ok: false,
          siteId: id,
          message: `${site.name} 在 ${Math.round(SEARCH_BUDGET_MS / 1000)} 秒内没有回话。这只说明这一次没等到，不代表站点坏了——点「重试」再试一次；本站在别的网络下能打开的话，是需要配代理。`,
        }),
      SEARCH_BUDGET_MS,
    )
  })
  try {
    return await Promise.race([attempt, budget])
  } finally {
    clearTimeout(timer)
  }
}

export async function mirrorsOf(id: string, detailUrl: string): Promise<SiteMirrorOutcome> {
  const site = getSite(id)
  if (!site) return { ok: false, siteId: id, message: `未知站点：${id}` }
  return site.adapter.mirrors(detailUrl)
}