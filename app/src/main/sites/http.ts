/**
 * 站点抓取用的 HTTP 小工具。全局 fetch 对中文站点够用，且自动跟随重定向；
 * 需要自定义请求头时在这里统一加，不要散落在各适配器里。
 */
import { setTimeout as sleep } from 'node:timers/promises'

/** 伪浏览器 UA：部分站点（如 gamer520 的镜像页）没有它可能直接 403。 */
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export interface FetchOpts {
  method?: string
  body?: string
  /** 请求 Referer，部分 ajax 接口校验它 */
  referer?: string
  headers?: Record<string, string>
  timeoutMs?: number
}

/** 带超时与 UA 的 fetch，返回已读入内存的 Response。 */
export async function httpFetch(url: string, opts: FetchOpts = {}): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15000)
  try {
    const headers: Record<string, string> = {
      'user-agent': BROWSER_UA,
      accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...opts.headers,
    }
    if (opts.referer) headers.referer = opts.referer
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      body: opts.body,
      headers,
      redirect: 'follow',
      signal: ctrl.signal,
    })
    // 不管状态码都把 body 读进来——错误页里可能藏着要解析的跳转。
    // 保留 content-disposition：部分站点用 attachment 头做反爬（空文件占位）
    const text = await res.text()
    const hd: Record<string, string> = { 'content-type': res.headers.get('content-type') ?? 'text/html' }
    const disp = res.headers.get('content-disposition')
    if (disp) hd['content-disposition'] = disp
    return new Response(text, { status: res.status, statusText: res.statusText, headers: hd })
  } finally {
    clearTimeout(timer)
  }
}

/** 简单文本 POST（form 编码）。返回解析后的 JSON（失败返回 null）。 */
export async function postForm(
  url: string,
  fields: Record<string, string>,
  referer?: string,
): Promise<unknown> {
  const body = new URLSearchParams(fields).toString()
  const res = await httpFetch(url, {
    method: 'POST',
    body,
    referer,
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
  })
  try {
    return JSON.parse(await res.text()) as unknown
  } catch {
    return null
  }
}

/** 拿 JSON。任何失败返回 null，调用方自行区分。 */
export async function getJson(url: string, referer?: string): Promise<unknown> {
  const res = await httpFetch(url, { referer, headers: { accept: 'application/json' } })
  try {
    return JSON.parse(await res.text()) as unknown
  } catch {
    return null
  }
}

/** 从 HTML 里提取第一个 <title>，去空白。 */
export function extractTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  return m ? m[1].trim() : ''
}

/** 简易重试：网络抖动时按 0.5s/1s/2s 退避重试，最多 3 次。 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      if (i < attempts - 1) await sleep(500 * 2 ** i)
    }
  }
  throw lastErr
}

export function isNetworkError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || /fetch failed|network/i.test(e.message))
}