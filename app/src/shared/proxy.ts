/**
 * 代理设置的解析与校验。
 *
 * 单独放在 shared：渲染层要拿它做输入框的即时校验，主进程要拿它决定
 * 到底下发什么。两边各写一份规则，迟早会出现「界面上能填、主进程判非法」。
 */

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i

/**
 * 支持的代理协议。socks5h 让 DNS 也在代理侧解析（被 DNS 污染的域名要靠它）。
 * 引擎侧 reqwest 需要 socks 特性才能真正吃下 socks4/5，见 engine-rs/Cargo.toml。
 */
const ALLOWED_SCHEMES = ['http', 'https', 'socks4', 'socks5', 'socks5h']

/**
 * 归一化成「带 scheme 的完整代理 URL」。空串 = 跟随系统代理。
 *
 * 为什么必须补 scheme：Rust 引擎用 `reqwest::Proxy::all()`，它只接受
 * `http://host:port` 这种完整 URL，喂 `127.0.0.1:7890` 会解析失败；
 * 而失败在原来的代码里被 `if let Ok(..)` 吞掉——用户以为代理开着，
 * 实际上一路直连，表现就是「代理软件明明开着，下载还是 403」。
 */
export function normalizeProxy(raw: string): string {
  const v = (raw ?? '').trim()
  if (!v) return ''
  const m = SCHEME_RE.exec(v)
  if (m) return `${m[1].toLowerCase()}://${v.slice(m[0].length)}`
  return `http://${v}`
}

/** 形状非法时返回中文原因；合法返回 null。空串合法（= 跟随系统代理）。 */
export function proxyFormatError(raw: string): string | null {
  const v = (raw ?? '').trim()
  if (!v) return null
  let u: URL
  try {
    u = new URL(normalizeProxy(v))
  } catch {
    return `代理地址看不懂：${v}。形如 http://127.0.0.1:7890。`
  }
  const scheme = u.protocol.replace(/:$/, '').toLowerCase()
  if (!ALLOWED_SCHEMES.includes(scheme)) {
    return `不支持的代理协议「${scheme}」，可用：${ALLOWED_SCHEMES.join(' / ')}。`
  }
  if (!u.hostname) return `代理地址缺少主机名：${v}。形如 http://127.0.0.1:7890。`
  if (u.port && !/^\d{1,5}$/.test(u.port)) return `代理端口不合法：${u.port}。`
  return null
}
