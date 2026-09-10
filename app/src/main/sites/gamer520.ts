/**
 * gamer520.com 适配器（Switch520 主题，WordPress + ripro 主题）。
 *
 * 实测链路（2026-09-10）：
 *   搜索   GET  {home}/?s=关键词           → 文章列表（/NNNNN.html）
 *   详情   GET  {home}/NNNNN.html          → 含 .go-down[data-id]
 *   取链   POST {home}/wp-admin/admin-ajax.php  {action:user_down_ajax,post_id}
 *          → {"status":"1","msg":"https://www.gamer520.com/go?post_id=..."}
 *   跳转   GET  go?post_id=...             → JS window.location='https://gamers520.com/...'
 *   镜像页 GET  https://gamers520.com/NNN.html → bdp-card 各网盘卡（百度/夸克/迅雷/gofile）
 *
 * 百度/夸克/迅雷需要账号或 App，只能浏览器手动；gofile 是海外直连盘，
 * 解析器会尝试 API 转直链（premium 限制时回退为页面链接）。
 */
import type { Mirror, SiteMirrorOutcome, SiteSearchOutcome, SiteSearchResult } from '../../shared/sites'
import { extractTitle, httpFetch, postForm, withRetry } from './http'

const HOME = 'https://www.gamer520.com'
const AJAX = `${HOME}/wp-admin/admin-ajax.php`

/** 站点 ID，与 registry.ts 保持一致。 */
export const SITE_ID = 'gamer520'

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

/** 文章链接形如 /NNNNN.html，标题在同个 <a> 里。 */
function parseSearchResults(html: string): SiteSearchResult[] {
  const out: SiteSearchResult[] = []
  const re = /<a[^>]+href="(https:\/\/www\.gamer520\.com\/\d+\.html)"[^>]*>([\s\S]*?)<\/a>/g
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
    // 1) 详情页拿 data-id
    const html = await withRetry(() => httpFetch(detailUrl).then((r) => r.text()))
    const idMatch = /data-id="(\d+)"/.exec(html) ?? /post_id["']?\s*[:=]\s*["']?(\d+)/.exec(html)
    if (!idMatch) {
      return { ok: false, siteId: SITE_ID, message: '详情页里没找到下载入口（.go-down[data-id]）。' }
    }
    const postId = idMatch[1]
    const title = extractTitle(html)

    // 2) ajax 拿 go 地址
    const ajax = await withRetry(() =>
      postForm(AJAX, { action: 'user_down_ajax', post_id: postId }, detailUrl),
    )
    const msg = (ajax as { status?: number; msg?: string } | null)?.msg
    if (!msg) {
      return {
        ok: false,
        siteId: SITE_ID,
        title,
        message: '下载接口没返回地址（可能需要登录或该资源已下架）。请在浏览器里打开该页手动下载。',
        mirrors: [{ kind: 'page', name: title || '详情页', url: detailUrl }],
      }
    }

    // 3) go 页 → JS 跳转 → 镜像页
    const mirrorPage = await followGo(msg)

    // 4) 镜像页里抠各网盘卡片
    const mirrors = parseMirrorPage(mirrorPage.html)
    if (!mirrors.length) {
      // go 端点返回空 attachment 是反爬占位（研究实测：正常时应是 134 字节 JS 跳转页）。
      // 此时把 go 地址本身作为 page 镜像交给 UI，在 webview 里走真实浏览器会话才能过。
      return {
        ok: true,
        siteId: SITE_ID,
        title,
        mirrors: [{ kind: 'page', name: title || '下载入口', url: mirrorPage.finalUrl }],
        message: '镜像页需要浏览器会话，请在页面里点「在浏览器打开」。',
      }
    }
    return { ok: true, siteId: SITE_ID, title, mirrors }
  } catch (e) {
    return { ok: false, siteId: SITE_ID, message: `解析失败：${(e as Error).message}` }
  }
}

/**
 * 跟随 go 地址。go 页可能 302，也可能只是包一层 JS 跳转：
 * <script>window.location='https://...'</script>，两跳都要处理。
 * 空响应（gamer520 的反爬占位）时不再死循环，直接返回让调用方决定回退方式。
 */
async function followGo(goUrl: string): Promise<{ html: string; finalUrl: string }> {
  let url = goUrl
  for (let i = 0; i < 4; i++) {
    const res = await httpFetch(url)
    const html = (await res.text()).trim()
    if (!html) return { html: '', finalUrl: url }
    const jsUrl = /window\.location\s*=\s*['"]([^'"]+)['"]/.exec(html)
    if (jsUrl) {
      url = new URL(jsUrl[1], url).toString()
      continue
    }
    return { html, finalUrl: url }
  }
  return { html: '', finalUrl: url }
}

/** 从镜像页抠网盘卡片。卡片结构（实测）：bdp-card bdp-{baidu,quark,xunlei,gofile}。 */
export function parseMirrorPage(html: string): Mirror[] {
  const mirrors: Mirror[] = []
  const push = (kind: Mirror['kind'], name: string, url: string, note?: string): void => {
    if (url && url.startsWith('http')) mirrors.push({ kind, name, url, note })
  }

  // 百度：二维码 data 里藏 pan.baidu.com 分享链接，旁边有提取码
  const baidu = /pan\.baidu\.com\/s\/[A-Za-z0-9_-]+/i.exec(html)
  if (baidu) {
    const pwd = /提取码\s*[:：]?\s*<strong>([^<]+)/i.exec(html)
    push('pan', '百度网盘', `https://${baidu[0]}`, pwd ? `提取码 ${pwd[1].trim()}` : undefined)
  }

  // 夸克：二维码 data 里藏 pan.quark.cn/s/xxx（一般要手机 App 扫码）
  const quark = /pan\.quark\.cn\/s\/[A-Za-z0-9_-]+/i.exec(html)
  if (quark) push('pan', '夸克网盘', `https://${quark[0]}`, '手机夸克 App 扫码')

  // 迅雷：直接是 <a href>
  const xunlei = /href="(https:\/\/pan\.xunlei\.com\/s\/[^"]+)"/i.exec(html)
  if (xunlei) push('pan', '迅雷云盘', xunlei[1])

  // gofile：直连海外盘
  const gofile = /href="(https:\/\/gofile\.io\/d\/[^"]+)"/i.exec(html)
  if (gofile) push('gofile', 'GOFILE 海外盘（直连）', gofile[1])

  // 其他常见直连/网盘主机（123 云盘、阿里云盘、夸克之外的），拿 href 或文本里的裸链接
  const extraHosts: Array<[RegExp, Mirror['kind'], string]> = [
    [/https:\/\/www\.123pan\.com\/s\/[A-Za-z0-9_-]+/i, 'pan', '123云盘'],
    [/https:\/\/www\.123684\.com\/s\/[A-Za-z0-9_-]+/i, 'pan', '123云盘'],
    [/https:\/\/www\.aliyundrive\.com\/s\/[A-Za-z0-9_-]+/i, 'pan', '阿里云盘'],
    [/https:\/\/www\.alipan\.com\/s\/[A-Za-z0-9_-]+/i, 'pan', '阿里云盘'],
    [/https:\/\/mega\.nz\/[A-Za-z0-9#!_-]+/i, 'pan', 'MEGA'],
    [/https:\/\/drive\.google\.com\/[^"'\s<>]+/i, 'pan', 'Google Drive'],
    [/https:\/\/pan\.quark\.cn\/s\/[A-Za-z0-9_-]+/i, 'pan', '夸克网盘'],
  ]
  for (const [re, kind, name] of extraHosts) {
    const m = re.exec(html)
    if (m) push(kind, name, m[0])
  }

  // 磁力 / torrent（如果有）
  const magnet = /magnet:\?[^"'\s<>"]+/i.exec(html)
  if (magnet) push('torrent', '磁力链接', magnet[0])

  // 解压密码：正文常写 解压密码:laoquzhang.com
  const pwdMatch = /解压密码\s*[:：]\s*([^\s<"']+)/i.exec(html)
  if (pwdMatch) {
    for (const m of mirrors) if (!m.note) m.note = `解压密码 ${pwdMatch[1]}`
  }

  // 去重（同一 URL 只留一条，gofile 优先保留）
  const seen = new Set<string>()
  return mirrors.filter((m) => {
    if (seen.has(m.url)) return false
    seen.add(m.url)
    return true
  })
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}
