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
import {
  EMPTY_STATE_MARKER,
  extractTitle,
  fetchText,
  httpFailureMessage,
  networkLayerHint,
  postForm,
  sameSiteUrl,
  withRetry,
} from './http'

const HOME = 'https://www.gamer520.com'
const AJAX = `${HOME}/wp-admin/admin-ajax.php`

/** 站点 ID，与 registry.ts 保持一致。 */
export const SITE_ID = 'gamer520'

// --------------------------------------------------------------- 搜索

export async function search(keyword: string): Promise<SiteSearchOutcome> {
  const q = encodeURIComponent(keyword.trim())
  try {
    const r = await withRetry(() => fetchText(`${HOME}/?s=${q}`))
    const http = httpFailureMessage(r)
    if (http) return { ok: false, siteId: SITE_ID, message: http }
    const region = resultsRegion(r.text)
    if (region === null) {
      if (EMPTY_STATE_MARKER.test(r.text)) {
        return { ok: true, siteId: SITE_ID, results: [], message: '没有搜到相关内容，换个关键词试试。' }
      }
      return {
        ok: false,
        siteId: SITE_ID,
        message: `搜索页（HTTP ${r.status}，${r.text.length} 字节）里找不到结果容器 posts-wrapper，gamer520 列表结构可能已改版。`,
      }
    }
    const results = parseSearchResults(region)
    if (!results.length) {
      return {
        ok: false,
        siteId: SITE_ID,
        message: '结果容器里一条文章链接都没解析出来，gamer520 卡片结构可能已改版。',
      }
    }
    return { ok: true, siteId: SITE_ID, results }
  } catch (e) {
    return { ok: false, siteId: SITE_ID, message: `搜索失败：${networkLayerHint(e)}` }
  }
}

/**
 * 只在列表容器里找。整页扫会把导航菜单里的固定文章链接也当结果——实测每条搜索
 * 都混进 61541.html/48671.html 两条与关键词无关的 Switch 菜单项。
 * 返回 null 表示容器不存在：可能是站点自己的「暂无内容」页，也可能是改版了。
 */
function resultsRegion(html: string): string | null {
  const i = html.search(/class="[^"]*posts-wrapper/)
  return i < 0 ? null : html.slice(i)
}

/**
 * 文章链接形如 /NNNNN.html，标题在同个 <a> 里。每个结果先是缩略图 <a>（里面只有
 * <img>，stripTags 后为空）后是带标题的 <a>，所以必须「标题非空才登记 seen」，
 * 否则缩略图那次会占掉 URL、带标题那次被当重复跳过，结果全丢。
 *
 * href 绝对/相对都吃（见 sameSiteUrl）：只认绝对写法时，站点改用相对路径
 * 会让这里解析出 0 条，而 0 条被报成「站点改版」——那是我们的假设错了。
 */
export function parseSearchResults(html: string): SiteSearchResult[] {
  const out: SiteSearchResult[] = []
  const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const url = sameSiteUrl(m[1], HOME, /^\/\d+\.html$/)
    if (!url || seen.has(url)) continue
    const title = stripTags(m[2]).trim()
    if (!title) continue
    seen.add(url)
    out.push({ siteId: SITE_ID, title, url })
  }
  return out
}

// --------------------------------------------------------------- 详情 → 镜像

export async function mirrors(detailUrl: string): Promise<SiteMirrorOutcome> {
  try {
    // 1) 详情页拿 data-id
    const r = await withRetry(() => fetchText(detailUrl))
    const http = httpFailureMessage(r)
    if (http) return { ok: false, siteId: SITE_ID, message: http }
    const html = r.text
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
    return { ok: false, siteId: SITE_ID, message: `解析失败：${networkLayerHint(e)}` }
  }
}

/**
 * 跟随 go 地址。go 页可能 302，也可能只是包一层 JS 跳转：
 * <script>window.location='https://...'</script>，两跳都要处理。
 * 空响应或非 2xx（gamer520 的反爬占位）时不再死循环，直接返回让调用方决定回退方式。
 */
async function followGo(goUrl: string): Promise<{ html: string; finalUrl: string }> {
  let url = goUrl
  for (let i = 0; i < 4; i++) {
    const r = await fetchText(url)
    const html = r.text.trim()
    if (!r.ok || !html) return { html: '', finalUrl: r.url || url }
    const jsUrl = /window\.location\s*=\s*['"]([^'"]+)['"]/.exec(html)
    if (jsUrl) {
      url = new URL(jsUrl[1], r.url || url).toString()
      continue
    }
    return { html, finalUrl: r.url || url }
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
