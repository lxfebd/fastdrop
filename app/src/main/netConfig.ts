/**
 * 网络出口配置：把「一份代理设置」下发到全部三条网络栈。
 *
 * 三条栈互不相通是这个文件存在的全部理由（实测记录在项目记忆
 * 「架构不变量」第 4 条）：
 * - Rust 下载引擎：只认引擎命令里的 proxy 字段（reqwest）；
 * - Chromium 栈：站点抓取层 + 内嵌浏览器，吃 session.setProxy()；
 * - （历史）主进程全局 fetch：谁的话都不听，已经废弃，见 sites/http.ts。
 *
 * 只在其中一处配置，用户看到的就是「浏览器里打得开的站，软件说连不上」，
 * 或者「代理软件开着，下载还是被 403」。
 */
import { session, type Session } from 'electron'
import { GAMESITES_PARTITION } from '../shared/sites'
import { normalizeProxy, proxyFormatError } from '../shared/proxy'

/** 吃 setProxy 的会话：默认会话（匿名探测）+ 游戏站内嵌浏览器分区。 */
function chromiumSessions(): Session[] {
  return [session.defaultSession, session.fromPartition(GAMESITES_PARTITION)]
}

/**
 * 下发代理到 Chromium 侧。留空 = `mode:'system'`（跟随系统代理，含 PAC），
 * 不写死任何本机相关的值。设置非法时抛中文原因，让保存动作当场失败而不是悄悄生效一半。
 */
export async function applyChromiumProxy(raw: string): Promise<void> {
  const bad = proxyFormatError(raw)
  if (bad) throw new Error(bad)
  const proxy = normalizeProxy(raw)
  const config = proxy
    ? { mode: 'fixed_servers' as const, proxyRules: proxy }
    : { mode: 'system' as const }
  for (const ses of chromiumSessions()) await ses.setProxy(config)
}

/**
 * 这一次下载该用什么代理（喂给 Rust 引擎的 reqwest 格式）。
 *
 * 设置里填了就用填的。留空时不能直接给引擎「空=直连」——那等于让引擎
 * 无视系统代理，和浏览器侧的行为分叉。也不能自己去读注册表：Windows 的系统代理
 * 还包含 PAC 脚本与按地址例外，读注册表必然读漏。
 * session.resolveProxy() 用的正是系统那一套，并且按目标地址给结论，
 * 所以拿它当「系统代理」的唯一事实来源。
 */
export async function engineProxyFor(targetUrl: string, raw: string): Promise<string> {
  const proxy = normalizeProxy(raw)
  if (proxy) return proxy
  let line = 'DIRECT'
  try {
    line = await session.defaultSession.resolveProxy(targetUrl)
  } catch {
    // 解析不了一切照旧直连：代理只是加速/绕阻断的手段，不该成为下载的前置条件
    return ''
  }
  return chromiumProxyToUrl(line)
}

/**
 * Chromium 的代理决策串 → reqwest 能吃的 URL。
 * 形如 `PROXY 127.0.0.1:7890`、`SOCKS5 host:port`、`DIRECT`，
 * 也可能是分号分隔的候选列表（取第一个真正给出主机的）。
 */
export function chromiumProxyToUrl(line: string): string {
  for (const entry of (line ?? '').split(';')) {
    const parts = entry.trim().split(/\s+/)
    const kind = (parts[0] ?? '').toUpperCase()
    const host = parts[1] ?? ''
    if (!host || kind === 'DIRECT' || kind === 'NONE') continue
    const scheme = kind === 'PROXY' ? 'http' : kind === 'SOCKS4' ? 'socks4' : kind === 'SOCKS5' ? 'socks5' : kind.toLowerCase()
    return `${scheme}://${host}`
  }
  return ''
}
