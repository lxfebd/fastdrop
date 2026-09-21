/**
 * 镜像解析器：把「网盘分享页 / gofile 文件夹」解析成可下载的直链。
 *
 * FastDrop 的 Rust 引擎只吃 HTTP/HTTPS 直链（预签名 URL 最理想，不需要
 * Cookie）。这里把能解析的尽量解析出来，解析不了的返回 page 镜像让用户在
 * webview 里手动处理。
 *
 * 实测结论（2026-09-10，全部联网验证）：
 * - gofile 文件夹 API 需要 guest token，但测试到的文件夹返回 error-notPremium，
 *   解析失败时回退为页面链接。
 * - pan.nekogal.top 是 Cloudreve v4，匿名 API 已完全打通：
 *     GET  /share/info/{id}                        分享信息
 *     GET  /file?uri=cloudreve://{id}@share        列目录（type 1=目录 0=文件）
 *     POST /file/url {uris:[path], download:true}  S3 预签名直链（约 1 小时有效）
 *   直链带 AWS4-HMAC-SHA256 签名，无需 Cookie/Referer，且支持 Range 分片
 *   （实测 HEAD 200 + accept-ranges: bytes，GET Range 0-1023 返回 206），
 *   可以直接喂给 Rust 引擎。
 */
import type { Mirror, ResolvedFile, ResolveOutcome } from '../../shared/sites'
import { fetchText, getJson, httpFailureMessage, networkLayerHint, parseJson } from './http'

/** 常见网盘域名。命中这些的镜像无法转直链，返回明确提示。 */
const PAN_HOSTS = [
  'pan.baidu.com',
  'pan.quark.cn',
  'pan.xunlei.com',
  'www.123pan.com',
  'www.123684.com',
  'www.aliyundrive.com',
  'www.alipan.com',
  'mega.nz',
  'drive.google.com',
]

export async function resolveMirror(m: Mirror): Promise<ResolveOutcome> {
  if (m.kind === 'direct' || m.kind === 'torrent') {
    return { ok: true, url: m.url, filename: filenameFromUrl(m.url) }
  }
  if (m.kind === 'gofile') return resolveGofile(m)
  if (m.kind === 'cloudreve' || /pan\.nekogal\.top/i.test(m.url)) return resolveCloudreve(m)
  const host = hostOf(m.url)
  if (host && PAN_HOSTS.some((h) => host === h || host.endsWith('.' + h))) {
    return {
      ok: false,
      message: `${m.name} 需要登录/App 才能下载，FastDrop 无法直接解析。请在游戏页签的浏览器里打开它。`,
    }
  }
  return { ok: false, message: '该链接不是可直接下载的文件地址，请在浏览器里打开。' }
}

// --------------------------------------------------------------- gofile

/**
 * gofile 的 API：POST /accounts 拿 guest token → GET /contents/{id}?wt={token}
 * 列文件 → 文件有 direct link。测试到的文件夹返回 error-notPremium，
 * 说明该文件夹被设为 premium-only。能解析时返回直链，否则回退页面链接。
 */
async function resolveGofile(m: Mirror): Promise<ResolveOutcome> {
  const id = /gofile\.io\/d\/([A-Za-z0-9]+)/i.exec(m.url)?.[1]
  if (!id) return { ok: false, message: '无法识别 gofile 文件夹 ID。' }
  try {
    let token: string | undefined
    for (const method of ['GET', 'POST'] as const) {
      const r = await fetchText('https://api.gofile.io/accounts', { method, headers: { accept: 'application/json' } })
      const j = (r.ok ? parseJson(r.text) : null) as { data?: { token?: string } } | null
      if (j?.data?.token) {
        token = j.data.token
        break
      }
    }
    if (!token) return { ok: false, message: '无法获取 gofile 匿名 token。请在浏览器里打开。', mirrors: [m] }

    const content = (await getJson(`https://api.gofile.io/contents/${id}?wt=${token}`)) as {
      status?: string
      data?: { children?: Record<string, { name?: string; link?: string; type?: string }> }
    } | null
    if (content?.status === 'ok' && content.data?.children) {
      const files = Object.values(content.data.children)
        .filter((k) => k.type === 'file' && k.link)
        .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', undefined, { numeric: true }))
      if (files.length) {
        const resolved = files.map((f) => ({
          url: f.link!,
          filename: f.name ?? filenameFromUrl(f.link!),
        }))
        return resolved.length === 1
          ? { ok: true, url: resolved[0].url, filename: resolved[0].filename }
          : { ok: true, files: resolved }
      }
    }
    return { ok: false, message: 'gofile 文件夹需要 premium 或未公开，请在浏览器里打开。', mirrors: [m] }
  } catch (e) {
    return { ok: false, message: `gofile API 访问失败：${reason(e)}。请在浏览器里打开。`, mirrors: [m] }
  }
}

// --------------------------------------------------------------- Cloudreve v4

/**
 * 网盘 API 基址。FD_CLOUDREVE_BASE 只给离线回归门用（tests/test_proxy_e2e.py 起一个
 * 假 Cloudreve，把「120 个文件截断成 60 个」这类只有大分享才会暴露的计数测出来）；
 * 不设置就是真实分享域名。这条链全程匿名、不带任何 Cookie，所以指错地址也
 * 泄露不了登录态。
 */
const CR_BASE = process.env.FD_CLOUDREVE_BASE ?? 'https://pan.nekogal.top/api/v4'

/**
 * 一次分享解析的收尾播报。
 *
 * 单独抽出来是因为这几行里有两处「吞掉信息」的老毛病：
 * - 分享里的文件超过 CR_MAX_FILES 时只取了前面一截，不说的话用户要到解压才发现缺件；
 * - 换直链失败的那几个（failed）以前完全不出现在任何提示里。
 * missing 是给渲染层的机器可读计数（决定要不要把分享页摊回浏览器），别让它去读中文。
 */
export function crBundleNote(
  shareName: string,
  total: number,
  extra: number,
  failed: number
): { message: string; missing: number } {
  const note = extra > 0 ? `（还有 ${extra} 个文件未加入，可在分享页查看）` : ''
  const failNote = failed > 0 ? `（另有 ${failed} 个文件取直链失败）` : ''
  return { message: `${shareName} 共 ${total} 个文件${note}${failNote}`, missing: extra + failed }
}

const CR_MAX_DEPTH = 8
const CR_PAGE_SIZE = 500
const CR_MAX_FILES = 60

interface CrEntry {
  type: number
  name: string
  path: string
  size: number
}

/**
 * pan.nekogal.top 的 Cloudreve v4 分享页。全程匿名，不需要登录：
 * 列目录拿 path，再用 /file/url 换 S3 预签名直链。分卷按名称做 numeric 排序，
 * 保证 .part1 在前。
 */
async function resolveCloudreve(m: Mirror): Promise<ResolveOutcome> {
  const shareId = /pan\.nekogal\.top\/s\/([A-Za-z0-9_-]+)/i.exec(m.url)?.[1]
  if (!shareId) return { ok: false, message: '无法识别 NekoGAL 网盘分享 ID。' }
  const rootUri = `cloudreve://${shareId}@share`

  try {
    const info = (await getJson(`${CR_BASE}/share/info/${shareId}`)) as
      | { code?: number; data?: { name?: string } }
      | null
    const shareName = info?.data?.name ?? m.name
    if (info?.code !== 0) {
      return {
        ok: false,
        message: 'NekoGAL 网盘分享不存在、已过期或需要密码。请在浏览器里打开该分享页。',
        mirrors: [{ kind: 'page', name: shareName, url: m.url }],
      }
    }

    const files = await crCollect(rootUri, [], 0)
    if (!files.length) {
      return {
        ok: false,
        message: 'NekoGAL 网盘里没有可下载的文件。',
        mirrors: [{ kind: 'page', name: shareName, url: m.url }],
      }
    }
    // 分卷要按 .part1/.part2 顺序入队
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    const head = files.slice(0, CR_MAX_FILES)
    const extra = files.length - head.length

    const resolved: ResolvedFile[] = []
    let failed = 0
    for (const f of head) {
      const url = await crDirectUrl(f.path)
      if (url) resolved.push({ url, filename: f.name, size: f.size })
      else failed++
    }
    if (!resolved.length) {
      return {
        ok: false,
        message: 'NekoGAL 网盘直链获取失败，请在浏览器里打开该分享页。',
        mirrors: [{ kind: 'page', name: shareName, url: m.url }],
      }
    }

    const { message, missing } = crBundleNote(shareName, files.length, extra, failed)
    const only = resolved[0]
    if (resolved.length === 1 && !failed && !extra) {
      // 一个文件、全部成功：没有要告知的事，别把「共 1 个文件」当成结果播报刷在屏幕上
      return { ok: true, url: only.url, filename: only.filename, size: only.size }
    }
    return { ok: true, files: resolved, message, missing }
  } catch (e) {
    return {
      ok: false,
      message: `NekoGAL 网盘访问失败：${reason(e)}。请在浏览器里打开。`,
      mirrors: [{ kind: 'page', name: m.name, url: m.url }],
    }
  }
}

/**
 * 失败原因。网络层的异常交给 networkLayerHint 分层（DNS/TCP/TLS/代理/超时），
 * 已经写成人话的（HTTP 状态、返回的不是 JSON）原样带上——吞掉原因等于让用户
 * 自己去猜该换网络、该配代理还是该重新分享。
 */
function reason(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return /net::|ERR_|ECONN|ENOTFOUND|ETIMEDOUT|abort|超时|没有响应/i.test(msg) ? networkLayerHint(e) : msg
}

/** 列一个目录。uri 形如 cloudreve://OnPtr@share 或 ...@share/父目录名。 */
async function crList(uri: string): Promise<CrEntry[]> {
  const r = await fetchText(`${CR_BASE}/file?uri=${encodeURIComponent(uri)}&page_size=${CR_PAGE_SIZE}`, {
    headers: { accept: 'application/json' },
  })
  const why = httpFailureMessage(r)
  if (why) throw new Error(`列目录 ${why}`)
  const j = parseJson(r.text) as {
    code?: number
    msg?: string
    data?: { files?: Array<Partial<CrEntry>> }
  } | null
  // 网关/风控经常拿 HTML 冒充 JSON，不点破的话用户只会看到「访问失败」
  if (!j) throw new Error(`列目录没有返回 JSON（HTTP ${r.status}，${r.contentType || '未知类型'}）`)
  if (j.code !== 0) throw new Error(j.msg ?? `code ${j.code} @ ${uri}`)
  return (j.data?.files ?? []).map((f) => ({
    type: f.type ?? 0,
    name: f.name ?? '',
    path: f.path ?? '',
    size: f.size ?? 0,
  }))
}

/** 递归收集分享内所有文件（跳过目录），限深防止异常递归。 */
async function crCollect(uri: string, acc: CrEntry[], depth: number): Promise<CrEntry[]> {
  if (depth > CR_MAX_DEPTH) return acc
  for (const k of await crList(uri)) {
    if (k.type === 1) {
      await crCollect(`${uri}/${k.name}`, acc, depth + 1)
    } else if (k.path) {
      acc.push(k)
    }
  }
  return acc
}

/** 把文件 path 换成预签名直链（POST /file/url）。失败返回 null。 */
async function crDirectUrl(path: string): Promise<string | null> {
  const r = await fetchText(`${CR_BASE}/file/url`, {
    method: 'POST',
    body: JSON.stringify({ uris: [path], download: true }),
    headers: { 'content-type': 'application/json', accept: 'application/json' },
  })
  if (!r.ok) return null
  const j = parseJson(r.text) as { code?: number; data?: { urls?: Array<{ url?: string }> } } | null
  return j?.code === 0 ? (j.data?.urls?.[0]?.url ?? null) : null
}

// --------------------------------------------------------------- 工具

function filenameFromUrl(url: string): string {
  try {
    const p = new URL(url).pathname
    const last = p.split('/').filter(Boolean).pop() ?? ''
    return decodeURIComponent(last) || 'download'
  } catch {
    return 'download'
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}
