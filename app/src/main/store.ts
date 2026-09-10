/**
 * 任务与设置的读写。移植自 idm/models.py 的 Store。
 *
 * 序列化格式刻意保持和 Python 版本逐字节兼容（indent=2、不转义中文、
 * 原子替换），因为新旧版本共用 ~/.fastdrop 数据目录，用户不想迁移数据。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Settings, TaskDef } from '../shared/types'
import { DEFAULT_SETTINGS } from '../shared/types'

function dataDir(): string {
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
 * 对应 Python 的 default_download_dir()——两边必须一致，否则老设置文件
 * 迁移过来后保存路径会漂移。
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
        })
      }
    }
    return out
  }

  saveTasks(tasks: TaskDef[]): void {
    writeJsonAtomic(taskFile(), tasks)
  }

  loadSettings(): Settings {
    const data = readJson(settingsFile())
    if (!data || typeof data !== 'object') {
      return { ...DEFAULT_SETTINGS, download_dir: defaultDownloadDir() }
    }
    const d = data as Partial<Settings>
    const s: Settings = { ...DEFAULT_SETTINGS }
    if (typeof d.threads === 'number') s.threads = d.threads
    if (typeof d.download_dir === 'string' && d.download_dir) s.download_dir = d.download_dir
    if (typeof d.proxy === 'string') s.proxy = d.proxy
    if (typeof d.user_agent === 'string') s.user_agent = d.user_agent
    if (typeof d.max_concurrent === 'number') s.max_concurrent = d.max_concurrent
    if (typeof d.confirm_delete === 'boolean') s.confirm_delete = d.confirm_delete
    if (typeof d.dark === 'boolean') s.dark = d.dark
    // 和 Python Settings.__post_init__ 一样：空目录补默认值，避免 dest 落成空串
    if (!s.download_dir) s.download_dir = defaultDownloadDir()
    return s
  }

  saveSettings(s: Settings): void {
    writeJsonAtomic(settingsFile(), s)
  }
}

/** 与 Python uuid.uuid4().hex[:12] 等价：12 位十六进制。 */
function newId(): string {
  return randomBytes(6).toString('hex')
}

/**
 * dest 指向目录时用 URL 文件名补全成完整文件路径。
 * 和 Python 版 _resolve_dest 行为一致，保证两边算出的保存路径相同。
 */
export function resolveDest(url: string, dest: string): string {
  if (!dest) return dest
  const isDir = dest.endsWith('/') || dest.endsWith('\\')
  if (!isDir) return dest
  const name = basename(new URL(url).pathname) || 'download'
  return join(dest, decodeURIComponent(name))
}
