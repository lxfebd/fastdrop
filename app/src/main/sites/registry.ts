/**
 * 游戏站注册表。新增站点只需在这里加一条 + 在 sites/ 下加对应的解析器
 * （实现 search/mirrors 两个函数），主进程与渲染层不需要再改。
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
}

const SITES: SiteRegistration[] = [
  {
    id: 'gamer520',
    name: 'Gamer520',
    home: 'https://www.gamer520.com',
    searchPlaceholder: '搜索 PC / Switch 游戏…',
    adapter: gamer520,
  },
  {
    id: 'nekogal',
    name: 'NekoGAL',
    home: 'https://www.nekogal.com',
    searchPlaceholder: '搜索 Galgame…',
    adapter: nekogal,
  },
  {
    id: 'playzip',
    name: 'PlayZip',
    home: 'https://playzip.com',
    searchPlaceholder: '搜索游戏…',
    adapter: playzip,
  },
]

/** 渲染进程展示用的站点元信息（不含 adapter）。 */
export function listSites(): SiteInfo[] {
  return SITES.map(({ id, name, home, searchPlaceholder }) => ({ id, name, home, searchPlaceholder }))
}

export function getSite(id: string): SiteRegistration | undefined {
  return SITES.find((s) => s.id === id)
}

/** 带默认站的搜索调用，省去调用方判空。 */
export async function searchSite(id: string, keyword: string): Promise<SiteSearchOutcome> {
  const site = getSite(id)
  if (!site) return { ok: false, siteId: id, message: `未知站点：${id}` }
  return site.adapter.search(keyword)
}

export async function mirrorsOf(id: string, detailUrl: string): Promise<SiteMirrorOutcome> {
  const site = getSite(id)
  if (!site) return { ok: false, siteId: id, message: `未知站点：${id}` }
  return site.adapter.mirrors(detailUrl)
}