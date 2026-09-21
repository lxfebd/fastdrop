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
  /**
   * 字节已写完、正在算校验和。只有配了 checksum 的任务会出现 true。
   * 一个 8 GB 的合集做 sha256 要几十秒，这段时间进度恒为 100%；
   * 没有这个标志界面只能说「下完了」，用户以为卡住又会去点暂停。
   */
  verifying: boolean
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
  cmd: 'probe' | 'run' | 'resume' | 'pause' | 'stop' | 'set_threads' | 'set_rate' | 'stats'
  url?: string
  dest?: string
  threads?: number
  proxy?: string
  user_agent?: string
  n?: number
  /** 该任务的下载上限，KiB/s，0 = 不限。所有分段共享同一个桶（aria2 的口径）。 */
  rate_limit_kbps?: number
  /** `sha256:<hex>` / `sha1:<hex>` / `md5:<hex>`，空 = 不校验。 */
  checksum?: string
}

/** 渲染进程关心的任务进度推送。 */
export interface TaskProgressPush {
  taskId: string
  snapshot: TaskSnapshot
}

/**
 * 应用设置。
 *
 * 通知/关窗/防休眠四个开关是新加的（原字段保持不动，序列化仍然向后兼容）：
 * 一个下载盒子常常要挂在托盘里跑几十分钟，用户看不见它的时候就全靠系统通知
 * 和「关窗后进程还活着」这两件事，所以它们必须是可配置的，而不是我们替用户决定。
 */
export interface Settings {
  threads: number
  download_dir: string
  proxy: string
  user_agent: string
  max_concurrent: number
  confirm_delete: boolean
  dark: boolean
  /** 任务下完时弹系统通知（窗口藏在托盘时唯一的告知渠道） */
  notify_on_finish: boolean
  /** 任务失败时弹系统通知，正文带失败原因和下一步建议 */
  notify_on_error: boolean
  /** 点关闭按钮只收进托盘，不退出程序 */
  close_to_tray: boolean
  /** 有任务在跑时阻止系统休眠（下到 90% 电脑睡了等于白下） */
  keep_awake: boolean
  /**
   * 全局下载限速，KiB/s，0 = 不限速。
   * 挂在后台跑的人需要它：不然全速下载会把直播、语音、游戏全部卡死。
   * 每个任务各拿一份额度（与 aria2 的 --max-download-limit 同口径），
   * 改设置时正在跑的任务立刻生效，不用重下。
   */
  rate_limit_kbps: number
  /**
   * 启动后自动检查应用更新。检查发现新版本会静默下载，下载完弹「重启安装」。
   * 默认开：没有这一行，用户永远不知道新版已经发布——发版日志写在
   * GitHub Release 里，界面里不主动提就没人看得到。
   */
  auto_update_check: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  threads: 8,
  download_dir: '',
  proxy: '',
  user_agent: '',
  max_concurrent: 3,
  confirm_delete: true,
  dark: true,
  notify_on_finish: true,
  notify_on_error: true,
  close_to_tray: true,
  keep_awake: false,
  rate_limit_kbps: 0,
  auto_update_check: true,
}

/** 持久化的任务定义（含最后一次已知进度）。字段与 idm.models.TaskDef 一致。 */
export interface TaskDef {
  id: string
  url: string
  dest: string
  threads: number
  proxy: string
  /** 添加时间，Unix 秒浮点 */
  added_at: number
  note: string
  /**
   * 最后一次已知的任务状态。'' = 从未跑过。
   * 没有这个字段时，重启后所有历史任务在内存里都是"没跑过"，调度器会把
   * 它们当成排队任务重新拉起——已经下完的文件会被重新下载并覆盖。
   */
  state: TaskState | ''
  /** 下列四个字段让重启后的列表能显示真实进度，而不是全部退回"排队中"。 */
  total: number
  downloaded: number
  error: string
  finished_at: number
  /**
   * 期望校验和，形如 `sha256:<hex>`；空串 = 不校验。
   * 必须跟着任务落盘：galgame 合集动辄十几个 GB，站点贴的 md5/sha1 是用户唯一
   * 能确认「下下来的东西和服务器那份是同一个」的手段，重启后丢了就再也没机会了。
   */
  checksum: string
}

/** 该任务是不是"等重启后自动续跑"的状态。done/paused/error 都不该被自动拉起。 */
export function isAutoResumable(state: TaskState | ''): boolean {
  return state === '' || state === 'queued' || state === 'downloading' || state === 'preparing'
}

const CHECKSUM_RE = /^(?:(sha256|sha1|md5):)?([0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/

/**
 * 把用户从页面上抄来的校验和规整成 `算法:小写十六进制`（引擎认的形状）。
 *
 * 认不出来时返回 null 而不是猜一个：把一串错的东西存进任务、等十几个 GB 下完
 * 再报「校验失败」，比当场说一句「这串读不懂」糟糕得多。空串是「不校验」，
 * 返回空串而不是 null，调用方据此分别处理。
 */
export function normalizeChecksum(raw: string): string | null {
  const s = raw.trim().toLowerCase()
  if (!s) return ''
  const m = CHECKSUM_RE.exec(s)
  if (!m) return null
  const hex = m[2]
  const alg = m[1] ?? (hex.length === 32 ? 'md5' : hex.length === 40 ? 'sha1' : 'sha256')
  return `${alg}:${hex}`
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

/**
 * 动作类 IPC 的统一返回。以前这些 handler 一律 resolve 成 undefined，
 * 渲染层没法区分「成功」和「主进程抛异常」，界面上一律提示成功、
 * 实际什么都没发生。
 */
export type ActionResult = { ok: true } | { ok: false; error: string }

/**
 * 保存设置的结果。必须带成功/失败两种形状：代理地址填错时，主进程既写了盘又
 * 没能下发到 Chromium，返回「保存成功」等于让用户在一个半生效状态里排查。
 */
export type SaveSettingsResult = { ok: true; settings: Settings } | { ok: false; error: string }

/** 新建任务的结果。duplicate=true 表示该链接已在列表里，没有重复建任务。 */
export type AddResult =
  | { ok: true; def: TaskDef; duplicate: boolean }
  | { ok: false; error: string }

/**
 * 应用更新状态的渲染层可见投影。
 *
 * 状态机只有一条前进路径，渲染层不自己发明状态，只映射主进程发的：
 * idle → checking → available → downloading → downloaded → installing
 *（下载中途出现 error 回到 idle，界面显示一段可读原因）。
 * 主进程保证同一时刻只发一个状态，渲染层拿到什么就显示什么。
 */
export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing'

export interface UpdateStatus {
  /** 当前阶段 */
  phase: UpdatePhase
  /** 新版本号，checking 之后才可能非空 */
  version?: string
  /** 下载进度 0..1，仅 downloading 阶段有 */
  progress?: number
  /** 已下载字节 / 总字节，仅 downloading 阶段有 */
  transferred?: number
  total?: number
  /** 出错时的人话原因（不把 electron-updater 的原始异常丢给用户） */
  error?: string
}

/** 空状态。渲染层拿不到任何推送时的初始值。 */
export const IDLE_UPDATE_STATUS: UpdateStatus = { phase: 'idle' }
