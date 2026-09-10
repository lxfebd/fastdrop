/**
 * nekogal.com 适配器（zibll 主题，WordPress）。
 *
 * 实测链路（2026-09-10）：
 *   搜索   GET  {home}/?s=关键词        → 文章列表（/archives/NNNN）
 *   详情   GET  {home}/archives/NNNN    → 含 .file-download-btn href="?golink=<base64>&nonce=.."
 *   解码   base64(golink)               → 真实下载地址（实测是 https://pan.nekogal.top/s/{share}）
 *   网盘   pan.nekogal.top 是 Cloudreve v4；share info 匿名可查，文件树/直链见 resolver
 */
import type { Mirror, SiteMirrorOutcome, SiteSearchOutcome, SiteSearchResult } from '../../shared/sites'
import { extractTitle, httpFetch, withRetry } from './http'

export const SITE_ID = 'nekogal'
const HOME = 'https://www.nekogal.com'

// --------------------------------------------------------------- 搜索

export async function search(keyword: string): Promise<SiteSearchOutcome> {
  const q = encodeURIComponent(keyword.trim())
  try {
    const html = await withRetry(() => httpFetch(`${HOME}/?s=${q}`).then((r) => r.text()))
    const results = parseSearchResults(html)
    if (!results.length) {
      return { ok: true, siteId: SITE_ID, results: [], message: '没有搜到相关内容，换个关键词试试。' }
    }
    return { ok: true, siteId: SITE_ID, results }
  } catch (e) {
    return { ok: false, siteId: SITE_ID, message: `搜索失败：${(e as Error).message}` }
  }
}

/** 文章链接形如 /archives/NNNN。 */
function parseSearchResults(html: string): SiteSearchResult[] {
  const out: SiteSearchResult[] = []
  const re = /<a[^>]+href="(https:\/\/www\.nekogal\.com\/archives\/\d+)"[^>]*>([\s\S]*?)<\/a>/g
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const url = m[1]
    if (seen.has(url)) continue
    seen.add(url)
    const title = stripTags(m[2]).trim()
    if (!title) continue
    out.push({ siteId: SITE_ID, title, url })
  }
  return out
}

// --------------------------------------------------------------- 详情 → 镜像

export async function mirrors(detailUrl: string): Promise<SiteMirrorOutcome> {
  try {
    const html = await withRetry(() => httpFetch(detailUrl).then((r) => r.text()))
    const title = extractTitle(html).replace(/-NekoGAL\s*-\s*Galgame传递者\s*$/, '').trim()

    // .file-download-btn 的 href 是 ?golink=<base64>&nonce=... ，可以直接取绝对地址
    const btn = /class="[^"]*file-download-btn[^"]*"[^>]*href="([^"]+)"/i.exec(html)
    if (!btn) {
      return { ok: false, siteId: SITE_ID, title, message: '详情页里没找到下载按钮（.file-download-btn）。' }
    }
    const fullUrl = new URL(btn[1], detailUrl).toString()
    const mirrors = decodeGolink(fullUrl, title)
    if (!mirrors.length) {
      return { ok: false, siteId: SITE_ID, title, message: '下载按钮解码失败，请在浏览器里打开详情页。' }
    }
    return { ok: true, siteId: SITE_ID, title, mirrors }
  } catch (e) {
    return { ok: false, siteId: SITE_ID, message: `解析失败：${(e as Error).message}` }
  }
}

/**
 * 从 golink URL 里解出真实下载地址。golink 参数是 base64；
 * 解码后可能是网盘分享页（Cloudreve / 其他盘）或直链。
 */
function decodeGolink(golinkUrl: string, title: string): Mirror[] {
  try {
    const u = new URL(golinkUrl)
    const b64 = u.searchParams.get('golink')
    if (!b64) return []
    const decoded = Buffer.from(b64, 'base64').toString('utf8')
    const link = decoded.trim()
    if (!/^https?:\/\//i.test(link)) return []

    if (/pan\.nekogal\.top\/s\//i.test(link)) {
      return [{ kind: 'cloudreve', name: 'NekoGAL 网盘', url: link, note: title }]
    }
    if (/pan\.|\/s\/|mega\.nz|drive\.google|123pan|alipan|aliyundrive|quark\.cn/i.test(link)) {
      return [{ kind: 'pan', name: '网盘链接', url: link }]
    }
    return [{ kind: 'direct', name: '直链', url: link }]
  } catch {
    return []
  }
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}