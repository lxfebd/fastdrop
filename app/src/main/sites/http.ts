/**
 * 站点抓取用的 HTTP 层。
 *
 * 走 Chromium 网络栈（electron.net），不走 Node 的 undici fetch。原因是这两套栈
 * 在真实世界里行为不同，而游戏页签的内嵌浏览器是 Chromium：
 * - 代理：session.setProxy() 只管 Chromium 栈，主进程全局 fetch 完全不吃它。
 *   实测（探针 fd_proxy_probe）：同一台机器同一个端口，配代理后 Chromium 侧命中、
 *   undici 侧命中 0。于是「浏览器里打得开的站，抓取层连不上」，用户看到的就是
 *   「我宿舍能搜到，我这儿搜不到」。
 * - 登录态：net.request 带 useSessionCookies 就能复用 persist:gamesites 里的
 *   站点 Cookie，用户在内嵌浏览器登录过，解析层就能看到登录后才有的内容。
 * - 风控：TLS/HTTP2 指纹与浏览器一致，服务器眼里不再是一个奇怪的 Node 客户端。
 *
 * 换来的代价（全部由探针 fd_probe4/5/6 实测钉死，不是推测）：
 * 1. net.request 没有 res.url。跟随重定向后拿不到终址，只能自己记 redirect 事件链
 *    —— 而 httpFailureMessage 的「被踢去登录页」判定唯一依赖终址，必须还原。
 * 2. 错误串是 Chromium 的 net::ERR_*，不是 Node 的 ECONNRESET/ENOTFOUND。
 *    networkLayerHint 的映射表必须跟着换，否则所有失败都退化成「Error: net::ERR_x」。
 * 3. req.abort() 之后不发 error、不发 aborted、不发 end，只有 req.abort + res.close。
 *    所以超时必须由自家定时器裁决，且要防二次 settle。
 * 4. req 的 'close' 在请求发出后立刻就到（它是「请求已提交」，不是「连接已断」），
 *    拿它当完成信号会把每个请求都判成空响应。
 */
import { net, session, type Session } from 'electron'
import { setTimeout as sleep } from 'node:timers/promises'
import { GAMESITES_PARTITION } from '../../shared/sites'

/** 伪浏览器 UA：部分站点（如 gamer520 的镜像页）没有它可能直接 403。 */
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 默认超时。站点首页普遍 3~8 秒，20 秒是 playzip 这类慢站的上限。 */
export const DEFAULT_TIMEOUT_MS = 15000

/**
 * 响应体上限。抓取层拿的是 HTML/JSON，正常几十到几百 KB；不设上限的话
 * 一个误指向大文件的地址会把主进程内存撑爆，连带整个调度器和正在下的任务一起没。
 */
const MAX_BODY_BYTES = 20 * 1024 * 1024

/** 'site' = 复用内嵌浏览器的登录态；'anon' = 不带任何会话 Cookie。 */
export type FetchSession = 'site' | 'anon'

export interface FetchOpts {
  method?: string
  body?: string
  /** 请求 Referer，部分 ajax 接口校验它 */
  referer?: string
  headers?: Record<string, string>
  timeoutMs?: number
  /**
   * 抓哪个会话。默认 'site'：跟用户在内嵌浏览器里看到的页面一致（能看登录后内容）。
   * 探测「这条链接离不离得开会话 Cookie」必须传 'anon'，否则探测永远得到「能下」，
   * 等于没探（见 bridge.ts 的捕获桥）。
   */
  sessionKind?: FetchSession
}

/** 一次抓取的产物：状态码 + 已经按响应头 charset 解好码的正文。 */
export interface FetchText {
  status: number
  /** HTTP 2xx。非 2xx 必须由调用方转成 ok:false + message，不许当「没结果」糊过去。 */
  ok: boolean
  statusText: string
  /** 跟随重定向后的最终地址，用来识别被踢去登录页的情况 */
  url: string
  contentType: string
  text: string
}

interface RawResponse {
  status: number
  ok: boolean
  statusText: string
  url: string
  contentType: string
  bytes: Buffer
}

/** Chromium 网络栈的会话。惰性取：模块加载时 app 可能还没 ready。 */
function fetchSession(kind: FetchSession | undefined): Session {
  return kind === 'anon' ? session.defaultSession : session.fromPartition(GAMESITES_PARTITION)
}

/**
 * 带超时、UA、charset 解码的抓取。先收原始字节再按 content-type 的 charset 解码
 * ——直接按 UTF-8 解，GBK/GB2312 输出的中文站标题全是乱码（探针实测：同一段字节
 * 按 GBK 解是「你好」，按 UTF-8 解是替换符）。
 */
export async function fetchText(url: string, opts: FetchOpts = {}): Promise<FetchText> {
  const r = await requestRaw(url, opts)
  return {
    status: r.status,
    ok: r.ok,
    statusText: r.statusText,
    url: r.url,
    contentType: r.contentType,
    text: decodeBody(r.bytes, r.contentType),
  }
}

/** 一次「只看头部」的探测产物：状态、终址、内容类型，正文一律不取。 */
export interface ProbeResult {
  status: number
  ok: boolean
  /** 跟随重定向后的最终地址，用来判断是否被弹回登录页/跳到别的源 */
  url: string
  contentType: string
}

/**
 * 探测一个地址：拿到响应头就结项并掐断正文。
 *
 * 用于「这条链接离得开会话 Cookie 吗」（捕获桥）——探测必须匿名，
 * 所以 sessionKind 传 'anon'。不取正文也就不会为一个大文件白跑一遍流量。
 */
export async function probeHead(url: string, opts: FetchOpts = {}): Promise<ProbeResult> {
  const r = await requestRaw(url, opts, true)
  return { status: r.status, ok: r.ok, url: r.url, contentType: r.contentType }
}

function requestRaw(url: string, opts: FetchOpts, headOnly = false): Promise<RawResponse> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const headers: Record<string, string> = {
    'user-agent': BROWSER_UA,
    accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...lowerKeys(opts.headers),
  }
  if (opts.referer) headers.referer = opts.referer

  return new Promise<RawResponse>((resolve, reject) => {
    // redirect 事件链：net.request 不暴露 res.url，终址只能自己记。
    // location 实测已是绝对地址，但仍过一遍 new URL() 兜住相对形式的服务端。
    let finalUrl = url
    let settled = false
    let gotResponse = false
    let received = 0
    let req: Electron.ClientRequest | null = null

    const fail = (e: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(e)
    }
    const finish = (r: RawResponse): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    /** 超时/超限要主动掐断连接。abort() 不会补发任何事件（探针实测），所以裁决在这里。 */
    const cutOff = (e: Error): void => {
      fail(e)
      try {
        req?.abort()
      } catch {
        // 请求已经结束，abort 会抛「no ongoing request」，无所谓
      }
    }

    const timer = setTimeout(() => {
      cutOff(
        gotResponse
          ? new TimeoutError(`读取中断（已收到 ${received} 字节后再无进展，${timeoutMs}ms 超时）`)
          : new TimeoutError(`连接超时（${timeoutMs}ms 内没拿到响应）`),
      )
    }, timeoutMs)

    try {
      req = net.request({
        method: (opts.method ?? 'GET').toUpperCase(),
        url,
        session: fetchSession(opts.sessionKind),
        // 匿名探测必须真空：带上会话 Cookie 的话站点会当成已登录用户放行
        useSessionCookies: opts.sessionKind !== 'anon',
        redirect: 'follow',
      })
    } catch (e) {
      fail(new Error(`无法发起请求：${e instanceof Error ? e.message : String(e)}`))
      return
    }

    for (const [k, v] of Object.entries(headers)) {
      if (v) req.setHeader(k, v)
    }

    req.on('redirect', (_status, _method, location) => {
      try {
        finalUrl = new URL(location, finalUrl).href
      } catch {
        // location 畸形到连 URL 都构造不出来，保持上一个已知地址
      }
    })

    req.on('error', (e) => fail(e))

    req.on('response', (res) => {
      gotResponse = true
      const status = res.statusCode
      const chunks: Buffer[] = []
      const contentType = firstHeader(res.headers['content-type'])
      const done = (): void =>
        finish({
          status,
          ok: status >= 200 && status < 300,
          statusText: res.statusMessage ?? '',
          url: finalUrl,
          contentType,
          bytes: Buffer.concat(chunks),
        })
      // res 是 Readable：没有 error 监听时，服务端中途断流会让它抛未捕获异常，
      // 那会把主进程连同正在下载的所有任务一起带走。必须挂上。
      res.on('error', (e: Error) => fail(e))
      // 探测模式：头部到手就结项，并立刻掐断正文。不等 end 是因为服务端可能
      // 正在推一个几十 GB 的文件，等它就等于白下一份。
      if (headOnly) {
        done()
        try {
          req?.abort()
        } catch {
          // 已无进行中的请求
        }
        return
      }
      res.on('data', (c: Buffer) => {
        received += c.length
        if (received > MAX_BODY_BYTES) {
          cutOff(new Error(`响应体超过 ${Math.round(MAX_BODY_BYTES / 1024 / 1024)} MiB 上限，这大概不是一个页面`))
          return
        }
        chunks.push(c)
      })
      res.on('end', done)
      // 少数服务端会掐流；不发终态的话只能靠定时器，白等一整个超时
      res.on('aborted', () => fail(new TimeoutError('连接在传输途中被服务端切断')))
    })

    try {
      req.end(opts.body)
    } catch (e) {
      fail(e instanceof Error ? e : new Error(String(e)))
    }
  })
}

/** 超时单独成类型：networkLayerHint 要把它和「被域名屏蔽」区分开。 */
class TimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AbortError'
  }
}

function lowerKeys(h: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(h ?? {})) out[k.toLowerCase()] = v
  return out
}

/** Electron 的 header 值在类型上是 string，实测个别版本会给数组。 */
function firstHeader(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '')
}

/** gbk/gb2312/gb18030/big5 交给 TextDecoder；charset 缺失或认不出一律退回 UTF-8。 */
function decodeBody(bytes: Uint8Array, contentType: string): string {
  const label = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1]?.trim()
  try {
    return new TextDecoder(label || 'utf-8').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/** 简单文本 POST（form 编码）。返回解析后的 JSON（失败返回 null）。 */
export async function postForm(
  url: string,
  fields: Record<string, string>,
  referer?: string,
): Promise<unknown> {
  const body = new URLSearchParams(fields).toString()
  const res = await fetchText(url, {
    method: 'POST',
    body,
    referer,
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
  })
  return parseJson(res.text)
}

/** 拿 JSON。任何失败返回 null，调用方自行区分。 */
export async function getJson(url: string, referer?: string): Promise<unknown> {
  const res = await fetchText(url, { referer, headers: { accept: 'application/json' } })
  return parseJson(res.text)
}

/**
 * 宽松 JSON 解析：解不出来给 null 而不是抛。
 * 站点接口经常拿 HTML 错误页冒充 JSON，调用方要能拿到「这不是 JSON」这个事实。
 */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/** 从 HTML 里提取第一个 <title>，去空白。 */
export function extractTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  return m ? m[1].trim() : ''
}

/** 非 2xx / 被踢去登录页时给人能看懂的原因；返回 null 表示这次响应可以拿去解析。 */
export function httpFailureMessage(r: FetchText): string | null {
  if (!r.ok) {
    const why = r.status === 403 || r.status === 429 ? '，可能被风控拦截' : r.status === 404 ? '，页面不存在' : ''
    return `站点返回 HTTP ${r.status}${r.statusText ? ` ${r.statusText}` : ''}${why}。`
  }
  if (/\/wp-login\.php|\/wp-signup\.php|[?&]redirect_to=/i.test(r.url)) {
    return `请求被跳转到了登录页（${r.url}），需要登录态才能看到内容。`
  }
  return null
}

/** 空态标记：解析出 0 条时用它区分「真没搜到」和「选择器被改版打断」。 */
export const EMPTY_STATE_MARKER = /暂无内容|没有找到|nothing found/i

/**
 * 把列表页里的 href 归一化成绝对地址，并且只接受本站（含子域）的链接。
 *
 * 以前两个站各自把绝对域名写死在正则里（`https://www.gamer520.com/\d+\.html`），
 * 于是站点只要改用相对路径，我们就解析出 0 条，报给用户的却是「列表结构可能已改版」——
 * 错的是我们自己那条假设，锅却甩给了站点。绝对、相对、协议相对三种写法在这里
 * 统一成绝对地址，外域的同形链接（`https://cdn.example.com/123.html`）照旧挡掉。
 */
export function sameSiteUrl(href: string, home: string, pathRe: RegExp): string | null {
  let u: URL
  let base: URL
  try {
    base = new URL(home)
    u = new URL(href, home)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  const root = base.hostname.toLowerCase().replace(/^www\./, '')
  const host = u.hostname.toLowerCase()
  if (host !== root && !host.endsWith(`.${root}`)) return null
  return pathRe.test(u.pathname) ? u.toString() : null
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

/**
 * Chromium 网络层的错误码 → 人话。
 *
 * 换栈之前这里是按 Node 的 errno（ENOTFOUND / ECONNRESET …）匹配的，那些串在
 * Chromium 栈里一个都不会出现，不补这张表的话所有失败都会退化成
 * 「Error: net::ERR_NAME_NOT_RESOLVED」——等于没报。
 * 取值来自实测（探针 fd_probe5）：DNS 挂 → ERR_NAME_NOT_RESOLVED，
 * 端口没人听 → ERR_CONNECTION_REFUSED，连上被 RST → ERR_EMPTY_RESPONSE，
 * 明文端口做 TLS → ERR_SSL_PROTOCOL_ERROR。
 */
const CHROMIUM_ERROR_HINTS: Array<[RegExp, string]> = [
  [/ERR_NAME_NOT_RESOLVED|ERR_DNS/, 'DNS 解析失败（域名解不出来：该地址在本机网络被屏蔽，或需要代理）'],
  [/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_ADDRESS_UNREACHABLE/, '本机当前没有到该地址的网络通路（网卡断开/切网/内网地址不可达）'],
  [/ERR_ADDRESS_INVALID|ERR_INVALID_URL/, '地址本身不合法'],
  [/ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_SOCKS_CONNECTION_FAILED|ERR_PROXY_CERTIFICATE_INVALID|ERR_PROXY_UNSUPPORTED|ERR_INVALID_AUTHENTICATION/, '代理连不上（设置里的代理地址/端口对不对？代理软件是否在运行）'],
  [/ERR_CONNECTION_REFUSED/, 'TCP 连接被拒绝（对方端口没在听）'],
  [/ERR_CONNECTION_RESET|ERR_CONNECTION_ABORTED|ERR_CONNECTION_TIMED_OUT|ERR_EMPTY_RESPONSE|ERR_SOCKET_NOT_CONNECTED/, '连上了但连接被重置（按域名/SNI 阻断的典型表现：换网络或配置代理可解）'],
  [/ERR_SSL|ERR_CERT|ERR_BAD_SSL/, 'TLS 握手失败（证书或协议问题；按 SNI 阻断也会表现成这样）'],
  [/ERR_TOO_MANY_REDIRECTS/, '重定向次数过多（站点登录态或跳转配置有问题）'],
  [/ERR_TIMED_OUT/, '连接超时（未到 HTTP 层）'],
]

/**
 * 把抓取异常归到具体哪一层：DNS / TCP / TLS / 代理 / 超时。playzip 这类站是网络层
 * 就被重置，报「搜索失败」等于没报，得让用户看得出该换网络、该配代理还是该改选择器。
 */
export function networkLayerHint(e: unknown): string {
  const err = e as { name?: string; message?: string }
  const detail = `${err?.message ?? ''} ${causeCode(e)}`
  if (err?.name === 'AbortError') return detail || '超时'
  for (const [re, hint] of CHROMIUM_ERROR_HINTS) if (re.test(detail)) return hint
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(detail)) return 'DNS 解析失败（域名解不出来）'
  if (/ECONNREFUSED/i.test(detail)) return 'TCP 连接被拒绝（对方端口没在听）'
  if (/ECONNRESET|ECONNABORTED|EOF|ILLEGAL_MESSAGE|handshake/i.test(detail)) return '连上了但连接被重置（可能被按域名阻断）'
  if (/SSL|TLS|certificate|alert/i.test(detail)) return 'TLS 层报错'
  if (/ETIMEDOUT|timed out/i.test(detail)) return '读取超时'
  return `${err?.name ?? 'Error'}: ${err?.message ?? ''}`.trim()
}

/** 老调用方（undici 时代）把真实错误塞在 cause 里，保留读一层。 */
function causeCode(e: unknown): string {
  const cause = (e as { cause?: unknown })?.cause
  if (cause instanceof Error) return `${cause.name} ${(cause as NodeJS.ErrnoException).code ?? ''} ${cause.message}`
  if (typeof cause === 'object' && cause) return String((cause as { code?: string }).code ?? '')
  return cause ? String(cause) : ''
}
