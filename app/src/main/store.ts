/**
 * 任务与设置的读写。
 *
 * 序列化格式刻意固定（indent=2、不转义中文、
 * 原子替换），因为新旧版本共用 ~/.fastdrop 数据目录，用户不想迁移数据。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import type { Settings, TaskDef, TaskState } from '../shared/types'
import { DEFAULT_SETTINGS } from '../shared/types'

const TASK_STATES: readonly string[] = [
  'queued',
  'idle',
  'preparing',
  'downloading',
  'paused',
  'done',
  'error',
  'cancelled',
]

/** 只认已知的状态字符串，别的（含人手改出来的值）一律当"从未跑过"。 */
function isTaskState(v: unknown): v is TaskState {
  return typeof v === 'string' && TASK_STATES.includes(v)
}

/** 设置与任务记录所在目录。界面起不来时，兜底页要能把这个目录交到用户手里。 */
export function dataDir(): string {
  if (process.env.FASTDROP_DATA_DIR) return process.env.FASTDROP_DATA_DIR
  return join(homedir(), '.fastdrop')
}

function taskFile(): string {
  return join(dataDir(), 'tasks.json')
}

function settingsFile(): string {
  return join(dataDir(), 'settings.json')
}

/**
 * 默认保存目录：优先 ~/Downloads，不存在时退回数据目录。
 * 这个默认值要稳定——改它会让老任务迁移过来后保存路径漂移。
 */
export function defaultDownloadDir(): string {
  const d = join(homedir(), 'Downloads')
  return existsSync(d) ? d : dataDir()
}

/** 读 JSON，任何失败都返回 null（老文件损坏时优雅降级，不炸启动）。 */
function readJson(path: string): unknown {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return null
  }
}

/** 原子写：先写 .tmp 再 rename，避免中途断电留下半截文件。 */
function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, path)
}

/**
 * 逐字段校验设置。渲染层传回来的对象不可信（可能是半截 JSON、被改坏的字段，
 * 或者干脆是别的进程塞进来的东西），非法值一律回落到默认值而不是写进盘里。
 * 读盘和保存走同一个函数，保证「存进去的」和「读出来的」形状一致。
 */
export function normalizeSettings(raw: unknown): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS }
  if (raw && typeof raw === 'object') {
    const d = raw as Partial<Settings>
    if (typeof d.threads === 'number') s.threads = clampInt(d.threads, 1, 64)
    if (typeof d.download_dir === 'string' && d.download_dir) s.download_dir = d.download_dir
    if (typeof d.proxy === 'string') s.proxy = d.proxy
    if (typeof d.user_agent === 'string') s.user_agent = d.user_agent
    if (typeof d.max_concurrent === 'number') s.max_concurrent = clampInt(d.max_concurrent, 1, 16)
    if (typeof d.confirm_delete === 'boolean') s.confirm_delete = d.confirm_delete
    if (typeof d.dark === 'boolean') s.dark = d.dark
    if (typeof d.notify_on_finish === 'boolean') s.notify_on_finish = d.notify_on_finish
    if (typeof d.notify_on_error === 'boolean') s.notify_on_error = d.notify_on_error
    if (typeof d.close_to_tray === 'boolean') s.close_to_tray = d.close_to_tray
    if (typeof d.keep_awake === 'boolean') s.keep_awake = d.keep_awake
    // 限速按 KiB/s 存。上限 100 GiB/s：这个值只会写进引擎的令牌桶，写大了等于
    // 不限速，但把负数/NaN 放过去会让引擎拿到一个说不清的数，所以照样 clamp。
    if (typeof d.rate_limit_kbps === 'number') {
      s.rate_limit_kbps = clampInt(d.rate_limit_kbps, 0, 104_857_600)
    }
    if (typeof d.auto_update_check === 'boolean') s.auto_update_check = d.auto_update_check
  }
  // 空目录补默认值，避免 dest 落成空串
  if (!s.download_dir) s.download_dir = defaultDownloadDir()
  return s
}

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, Math.floor(v)))
}

export class Store {
  constructor() {
    mkdirSync(dataDir(), { recursive: true })
  }

  loadTasks(): TaskDef[] {
    const data = readJson(taskFile())
    if (!Array.isArray(data)) return []
    const out: TaskDef[] = []
    for (const item of data) {
      const d = item as Partial<TaskDef>
      // 只收结构完整的任务定义，跳过坏条目而不是让整个列表加载失败
      if (d && typeof d.url === 'string' && d.url) {
        out.push({
          id: typeof d.id === 'string' && d.id ? d.id : newId(),
          url: d.url,
          dest: typeof d.dest === 'string' ? d.dest : '',
          threads: typeof d.threads === 'number' ? d.threads : 8,
          proxy: typeof d.proxy === 'string' ? d.proxy : '',
          added_at: typeof d.added_at === 'number' ? d.added_at : Date.now() / 1000,
          note: typeof d.note === 'string' ? d.note : '',
          // 老版本 tasks.json 没有状态字段：按"从未跑过"处理，让调度器像以前
          // 一样首次拉起它，而不是凭空认为它已经完成。
          state: isTaskState(d.state) ? d.state : '',
          total: typeof d.total === 'number' ? d.total : 0,
          downloaded: typeof d.downloaded === 'number' ? d.downloaded : 0,
          error: typeof d.error === 'string' ? d.error : '',
          finished_at: typeof d.finished_at === 'number' ? d.finished_at : 0,
          // 老 tasks.json 没这个字段：空串 = 不校验。不能拿 undefined 去喂引擎，
          // 也不能顺手填个别的任务的哈希值——那会把一次正常下载判成校验失败。
          checksum: typeof d.checksum === 'string' ? d.checksum : '',
        })
      }
    }
    return out
  }

  saveTasks(tasks: TaskDef[]): void {
    writeJsonAtomic(taskFile(), tasks)
  }

  loadSettings(): Settings {
    return normalizeSettings(readJson(settingsFile()))
  }

  saveSettings(s: Settings): void {
    writeJsonAtomic(settingsFile(), normalizeSettings(s))
  }
}

/**
 * 目标路径上已经有文件时改名，绝不覆盖。
 * 下载目录里躺着的可能是用户自己的文件，和这次要下的东西毫无关系——
 * 实测过：路径撞车时旧文件会被新下载整份替换掉。
 */
export function uniquePath(p: string): string {
  if (!p || !existsSync(p)) return p
  const dir = dirname(p)
  const ext = extname(p)
  const stem = basename(p, ext)
  for (let i = 1; i < 1000; i++) {
    const cand = join(dir, `${stem} (${i})${ext}`)
    if (!existsSync(cand)) return cand
  }
  return p
}

/** 12 位十六进制随机 ID。 */
function newId(): string {
  return randomBytes(6).toString('hex')
}

/**
 * 从 URL/服务端给的名字里取出可以安全落盘的文件名。
 *
 * 顺序很关键：必须先解码再取 basename。反过来的话 `%2e%2e%2f` 这种编码过的
 * `../` 会在解码后变成真正的路径分隔符，把保存路径从下载目录里逃出去。
 * 兜底再把任何分隔符与 Windows 保留字符替换掉。
 */
export function safeFileName(name: string): string {
  let s = name
  try {
    s = decodeURIComponent(name)
  } catch {
    // 非法百分号编码（`%zz`）就用原串
  }
  s = basename(s).replace(/[\\/]/g, '_').replace(/[<>:"|?*\x00-\x1f]/g, '_').trim()
  while (s.startsWith('.')) s = `_${s.slice(1)}`
  return s || 'download'
}
