/**
 * playzip.com 适配器。
 *
 * 注意（2026-09-21 复测）：本机到该站的连接在 **TLS 握手阶段被 RST**：
 *   DNS 正常（Cloudflare 104.20.18.68 / 172.66.154.174）→ TCP :443 能连上
 *   → ClientHello 发出后连接被重置；把 SNI 换成 playzip.com 打到别的可达 IP
 *   上同样被重置，而 80 端口也是 reset。即按 SNI 做的路径阻断，不是 URL/协议
 *   写错，也不是解析层问题。因此这里只做一次真实抓取，把失败层报清楚；
 *   页面结构仍未实测确认，抓取通了但解析不出结果时会明确说「选择器未验证」。
 */
import type { SiteMirrorOutcome, SiteSearchOutcome } from '../../shared/sites'
import type { FetchText } from './http'
import { fetchText, httpFailureMessage, networkLayerHint } from './http'

export const SITE_ID = 'playzip'
const HOME = 'https://playzip.com'

export async function search(keyword: string): Promise<SiteSearchOutcome> {
  const url = `${HOME}/?s=${encodeURIComponent(keyword.trim())}`
  let r: FetchText
  try {
    r = await fetchText(url, { timeoutMs: 20000 })
  } catch (e) {
    return { ok: false, siteId: SITE_ID, message: `playzip 连不上：${networkLayerHint(e)}。这是本机到站点的网络层故障，换网络或稍后再试。` }
  }
  const http = httpFailureMessage(r)
  if (http) return { ok: false, siteId: SITE_ID, message: `playzip ${http}` }
  return {
    ok: false,
    siteId: SITE_ID,
    message: `playzip 能访问（HTTP ${r.status}）但结果解析未上线：该站页面结构从未经实测确认过，不敢按猜的选择器解析。`,
  }
}

export async function mirrors(detailUrl: string): Promise<SiteMirrorOutcome> {
  let r: FetchText
  try {
    r = await fetchText(detailUrl, { timeoutMs: 20000 })
  } catch (e) {
    return {
      ok: false,
      siteId: SITE_ID,
      message: `playzip 连不上：${networkLayerHint(e)}，无法解析下载链接。请在浏览器中直接访问该页。`,
    }
  }
  const http = httpFailureMessage(r)
  if (http) return { ok: false, siteId: SITE_ID, message: `playzip ${http}` }
  return {
    ok: false,
    siteId: SITE_ID,
    message: 'playzip 详情页能访问，但下载按钮的选择器从未经实测确认，不做猜测式解析。请在浏览器里打开该页。',
  }
}
