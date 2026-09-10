/**
 * 展示层的数字格式化。规则固定如下：
 * （IDM 系下载工具的显示习惯，不是随手写好看就行）：
 *   - 单位换算固定 1KB = 1024，不用 SI 的 1000
 *   - 速度非正时显示 "0 B/s"，不是破折号（破折号留给"未知"）
 *   - ETA 超过 30 天视为不可靠，显示 "—"
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

export function fmtSize(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined) return '—'
  let v = Number(n)
  if (!Number.isFinite(v) || v < 0) return '—'
  for (const u of UNITS) {
    if (v < 1024 || u === UNITS[UNITS.length - 1]) {
      return u === 'B' ? `${Math.round(v)} ${u}` : `${v.toFixed(digits)} ${u}`
    }
    v /= 1024
  }
  return '—'
}

export function fmtSpeed(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || bps <= 0) return '0 B/s'
  return `${fmtSize(bps)}/s`
}

export function fmtEta(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0 || seconds > 86400 * 30) return '—'
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const rem = s % 3600
  const m = Math.floor(rem / 60)
  const sec = rem % 60
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${sec}s`
  return `${sec}s`
}

export function fmtProgress(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return '0.0%'
  return `${(p * 100).toFixed(1)}%`
}

/**
 * 取路径的文件名部分。同时处理 Windows 反斜杠和 POSIX 正斜杠——
 * 任务在 Windows 上写盘，但 URL 解析出来是正斜杠，两种都得认。
 */
export function fileName(path: string): string {
  const i = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return i >= 0 ? path.slice(i + 1) : path
}

/** 取路径的目录部分。路径里没有任何分隔符时返回空串。 */
export function dirName(path: string): string {
  const i = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return i > 0 ? path.slice(0, i) : ''
}

export function fmtTime(ts: number | null | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
