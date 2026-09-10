/**
 * 任务状态 → 展示元数据。对应 fastdrop/widgets.py 的 STATUS 表，
 * 文案和 ant Tag 的 preset 颜色都在这定义，模板里不要再散落判断。
 */
import type { TaskState } from '../shared/types'

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
 * 侧栏过滤与行是否显示的匹配规则。对应 Python 的 _match：
 * 「下载中」桶同时收 preparing，因为 preparing 视觉上就是一段等待中。
 */
export function matchesFilter(state: string | undefined, filter: string): boolean {
  if (filter === 'all') return true
  const st = state ?? 'queued'
  if (filter === 'downloading') return st === 'downloading' || st === 'preparing'
  return st === filter
}
