/**
 * 主进程 / preload / 渲染进程共享的类型定义。
 *
 * 序列化字段名是跨版本契约：主进程、preload、渲染进程共用同一份
 * ~/.fastdrop 数据目录，字段名一变老任务就读不出来、断点也失效。
 * 引擎侧的字段名同理，要和 engine-rs 的 JSON 输出对齐。
 */

/** 任务状态。与 Rust 引擎 Task.state 的取值集合一致。 */
export type TaskState =
  | 'queued'
  | 'idle'
  | 'preparing'
  | 'downloading'
  | 'paused'
  | 'done'
  | 'error'
  | 'cancelled'

/** 单个分段的进度。字段直接来自 engine-rs 的 Segment::snapshot()。 */
export interface SegmentInfo {
  index: number
  /** 该分段自身进度，0..1 */
  progress: number
  /** waiting | downloading | done | error */
  status: string
  /** 该分段速率，字节/秒 */
  speed: number
  /** 该分段字节数 */
  size: number
}

/** 一个任务的实时快照。字段与 engine-rs Task::snapshot() 逐一对齐。 */
export interface TaskSnapshot {
  url: string
  dest: string
  filename: string
  total: number
  downloaded: number
  /** 已下载字节占总数比例，0..1。注意字段名是 progress，不是 ratio。 */
  progress: number
  /** 滑动窗口估计的速率，字节/秒 */
  speed: number
  /** 预计剩余秒数，未知时为 0 */
  eta: number
  state: TaskState
  error: string
  threads: number
  segments: SegmentInfo[]
  /** 完成时间（Unix 秒浮点），未完成时为 0 */
  finished_at: number
}

/** 引擎 → 主进程的单条事件。 */
export interface EngineEvent {
  event: 'progress' | 'done' | 'error' | 'log'
  data?: Partial<TaskSnapshot> & { state?: TaskState }
  total?: number
  error?: string
  message?: string
}

/** 主进程 → Rust 引擎的命令。cmd 之外的字段按命令选用。 */
export interface EngineCommand {
  cmd: 'probe' | 'run' | 'resume' | 'pause' | 'stop' | 'set_threads' | 'stats'
  url?: string
  dest?: string
  threads?: number
  proxy?: string
  user_agent?: string
  n?: number
}

/** 渲染进程关心的任务进度推送。 */
export interface TaskProgressPush {
  taskId: string
  snapshot: TaskSnapshot
}

/** 应用设置。字段与老 settings.json 完全一致。 */
export interface Settings {
  threads: number
  download_dir: string
  proxy: string
  user_agent: string
  max_concurrent: number
  confirm_delete: boolean
  dark: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  threads: 8,
  download_dir: '',
  proxy: '',
  user_agent: '',
  max_concurrent: 3,
  confirm_delete: true,
  dark: true,
}

/** 持久化的任务定义（不含实时进度）。字段与 idm.models.TaskDef 一致。 */
export interface TaskDef {
  id: string
  url: string
  dest: string
  threads: number
  proxy: string
  /** 添加时间，Unix 秒浮点 */
  added_at: number
  note: string
}

/** 列表 UI 用的行数据：定义 + 实时快照（可能为空）。 */
export interface TaskRow {
  id: string
  def: TaskDef
  snap: TaskSnapshot | null
}

/** 各状态的计数，用于工具栏与侧栏角标。 */
export interface StatusCounts {
  downloading: number
  paused: number
  queued: number
  done: number
  error: number
}
