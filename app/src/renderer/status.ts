/**
 * 任务状态 → 展示元数据。
 * 文案和 ant Tag 的 preset 颜色都在这定义，模板里不要再散落判断。
 */
import type { TaskDef, TaskRow, TaskSnapshot, TaskState } from '../shared/types'
import { fileName, fmtProgress } from '../shared/format'

export interface StatusMeta {
  key: TaskState
  label: string
  /** ant Tag 的 preset 色 */
  tone: 'blue' | 'default' | 'success' | 'error' | 'warning'
}

const STATUS: Record<string, StatusMeta> = {
  downloading: { key: 'downloading', label: '下载中', tone: 'blue' },
  paused: { key: 'paused', label: '已暂停', tone: 'default' },
  done: { key: 'done', label: '已完成', tone: 'success' },
  error: { key: 'error', label: '失败', tone: 'error' },
  queued: { key: 'queued', label: '排队中', tone: 'default' },
  idle: { key: 'idle', label: '等待', tone: 'default' },
  preparing: { key: 'preparing', label: '准备中', tone: 'default' },
  cancelled: { key: 'cancelled', label: '已取消', tone: 'default' },
}

/** 未知状态回落到 idle，避免模板里出现 undefined 分支。 */
export function statusMeta(state: string): StatusMeta {
  return STATUS[state] ?? STATUS.idle
}

/**
 * 侧栏过滤与行是否显示的匹配规则：
 * 「下载中」桶同时收 preparing，因为 preparing 视觉上就是一段等待中。
 */
export function matchesFilter(state: string | undefined, filter: string): boolean {
  if (filter === 'all') return true
  const st = state ?? 'queued'
  if (filter === 'downloading') return st === 'downloading' || st === 'preparing'
  return st === filter
}

// ------------------------------------------------------- 未知长度 / 校验中

/** 徽标真正显示的内容。 */
export interface StatusBadge {
  label: string
  tone: StatusMeta['tone']
}

/**
 * 显示用的状态文案与配色。
 *
 * verifying 和「大小未知」都不进 TaskState——那是跨进程的持久化与调度契约，
 * 多加一个取值会把落盘和排队逻辑一起带坏；它们只是同一个状态下的不同处境，
 * 所以只在这里改文案。
 *
 * compact=true 给列表行的状态列：那一列是 64px 定宽（CDP 正在量列宽），
 * 只放得下三个汉字，长说明由副标题和详情卡承担。
 */
export function statusBadge(
  state: TaskState,
  snap: TaskSnapshot | null,
  def: TaskDef | null,
  compact: boolean,
): StatusBadge {
  const meta = statusMeta(state)
  if (snap?.verifying) return { label: '校验中', tone: meta.tone }
  if (!compact && state === 'downloading' && totalBytes(snap, def?.total ?? 0) <= 0) {
    return { label: '下载中（大小未知）', tone: meta.tone }
  }
  return { label: meta.label, tone: meta.tone }
}

/** 已知总长；0 = 服务器没报 Content-Length，下完才会变成真实字节数。 */
export function totalBytes(snap: TaskSnapshot | null, defTotal: number): number {
  const t = snap?.total || defTotal || 0
  return Number.isFinite(t) && t > 0 ? t : 0
}

/**
 * 进度比例，null 表示「算不出来」。
 *
 * 不能拿 0 顶替 null：chunked 任务的 total 恒为 0，写成 0% 等于对着一个正在
 * 下 8 GB 的文件说「一点都没下」，用户下一步就是点暂停。
 * 校验中同理给满：字节这时候确实全都落盘了，剩下的只是算哈希。
 */
export function progressRatio(snap: TaskSnapshot | null, def: TaskDef | null): number | null {
  if (snap?.verifying) return 1
  const total = totalBytes(snap, def?.total ?? 0)
  if (!total) return null
  const raw = snap ? snap.progress : (def?.downloaded ?? 0) / total
  if (!Number.isFinite(raw)) return null
  return Math.max(0, Math.min(1, raw))
}

/** 百分比文案。破折号是 format.ts 给「未知」定的写法，这里不另造一套。 */
export function percentText(ratio: number | null): string {
  return ratio === null ? '—' : fmtProgress(ratio)
}

// ---------------------------------------------------------------- 搜索与排序

/** 行状态：没快照（重启后引擎没拉起来）时回落到落盘的定义。 */
export function rowState(r: TaskRow): TaskState | '' {
  return r.snap?.state ?? r.def.state
}

/** 展示用文件名。dest 可能是 Windows 反斜杠路径，fileName() 两种分隔符都认。 */
export function rowName(r: TaskRow): string {
  return fileName(r.def.dest) || r.def.url
}

/**
 * 关键词匹配。搜索和状态过滤是「与」关系：先按桶筛、再按词筛，
 * 用户要的是「失败的里面哪个是 1.2 号补丁」，不是二选一。
 */
export function matchesQuery(r: TaskRow, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return rowName(r).toLowerCase().includes(q) || r.def.url.toLowerCase().includes(q)
}

/**
 * 排序方式。value 直接是 IPC/本地状态的键，label 是选择框文案。
 * 默认按添加时间倒序——和新任务出现在最上面的直觉一致（也就是现状）。
 */
export type TaskSort = 'added-desc' | 'added-asc' | 'name' | 'progress' | 'size' | 'speed'

export const SORT_OPTIONS: { value: TaskSort; label: string }[] = [
  { value: 'added-desc', label: '最近添加' },
  { value: 'added-asc', label: '最早添加' },
  { value: 'name', label: '名称 A→Z' },
  { value: 'progress', label: '进度' },
  { value: 'size', label: '文件大小' },
  { value: 'speed', label: '当前速度' },
]

/** 取快照里已经知道的大小；没有快照就用落盘的值。 */
function rowTotal(r: TaskRow): number {
  return totalBytes(r.snap, r.def.total)
}

/**
 * 稳定排序，返回新数组（不原地改 state.rows——那是轮询与推送共同持有的对象）。
 */
export function sortRows(rows: TaskRow[], sort: TaskSort): TaskRow[] {
  const out = [...rows]
  switch (sort) {
    case 'added-asc':
      return out.sort((a, b) => a.def.added_at - b.def.added_at)
    case 'name':
      return out.sort((a, b) =>
        rowName(a).localeCompare(rowName(b), 'zh-Hans-CN', { numeric: true, sensitivity: 'accent' }),
      )
    case 'progress':
      return out.sort((a, b) => (b.snap?.progress ?? 0) - (a.snap?.progress ?? 0))
    case 'size':
      return out.sort((a, b) => rowTotal(b) - rowTotal(a))
    case 'speed':
      return out.sort((a, b) => (b.snap?.speed ?? 0) - (a.snap?.speed ?? 0))
    case 'added-desc':
    default:
      return out.sort((a, b) => b.def.added_at - a.def.added_at)
  }
}
