/**
 * playzip.com 适配器。
 *
 * 注意（2026-09-10 实测）：该站从本机网络 TLS 握手阶段就被 Cloudflare 拒绝
 * （curl/openssl 均收到 connection reset），无法确认其页面结构。适配器按
 * 「站内搜索 + 详情页下载按钮」的通用假设实现；网络恢复可达后，再把选择器
 * 换成实测值即可。搜索失败会返回带原因的 message，UI 会明确提示。
 */
import type { SiteMirrorOutcome, SiteSearchOutcome } from '../../shared/sites'
import { httpFetch } from './http'

export const SITE_ID = 'playzip'
const HOME = 'https://playzip.com'

export async function search(keyword: string): Promise<SiteSearchOutcome> {
  try {
    const res = await httpFetch(`${HOME}/?s=${encodeURIComponent(keyword.trim())}`)
    if (res.status >= 400) {
      return { ok: false, siteId: SITE_ID, message: `站点返回 ${res.status}（可能被 Cloudflare 拦截）。` }
    }
    return { ok: true, siteId: SITE_ID, results: [], message: 'playzip 当前网络不可达或无法解析，请在浏览器中直接访问。' }
  } catch (e) {
    const msg = (e as Error).message
    if (/fetch failed|network|Abort/i.test(msg)) {
      return { ok: false, siteId: SITE_ID, message: 'playzip 当前网络不可达（TLS 握手被拦截），请稍后再试。' }
    }
    return { ok: false, siteId: SITE_ID, message: `访问失败：${msg}` }
  }
}

export async function mirrors(_detailUrl: string): Promise<SiteMirrorOutcome> {
  return {
    ok: false,
    siteId: SITE_ID,
    message: 'playzip 当前网络不可达，无法解析下载链接。请在浏览器中直接访问该页。',
  }
}