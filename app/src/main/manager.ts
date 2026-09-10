/**
 * 任务调度器。移植自 idm/manager.py。
 *
 * 引擎只负责单个任务，这里负责全局调度：
 *   - 并发上限（同时最多几个任务在跑）
 *   - 排队 / 出队 / 重试
 *   - 把引擎回调转成推送到渲染进程
 *
 * Node 是单线程的，所以 Python 里的 threading.RLock 在这里不需要了——
 * 主进程的事件循环就是唯一的执行上下文，不存在并发写。
 */
import { basename, join } from 'node:path'
import { statSync } from 'node:fs'
import { EngineTask } from './engine'
import { randomBytes } from 'node:crypto'
import type {
  Settings,
  StatusCounts,
  TaskDef,
  TaskProgressPush,
  TaskRow,
  TaskSnapshot,
} from '../shared/types'

export interface AddInput {
  url: string
  dest: string
  threads?: number
  note?: string
}

export type PersistFn = (tasks: TaskDef[]) => void

/** dest 是不是已存在的目录。路径不存在或不是目录都返回 false（当作文件路径）。 */
function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** 调度中心：持有任务定义表、运行中的引擎实例、排队顺序。 */
export class Manager {
  settings: Settings
  private defs = new Map<string, TaskDef>()
  private tasks = new Map<string, EngineTask>()
  private order: string[] = []
  private onPush: (p: TaskProgressPush) => void
  private persist: PersistFn

  constructor(
    settings: Settings,
    onPush: (p: TaskProgressPush) => void,
    persist: PersistFn = () => {},
    initialDefs: TaskDef[] = [],
  ) {
    this.settings = settings
    this.onPush = onPush
    this.persist = persist
    for (const d of initialDefs) this.register(d)
  }

  /** 注册任务定义。persist 时按 order 顺序落盘。 */
  private register(d: TaskDef): void {
    this.defs.set(d.id, d)
    if (!this.order.includes(d.id)) this.order.push(d.id)
  }

  listDefs(): TaskDef[] {
    return this.order.map((id) => this.defs.get(id)).filter((d): d is TaskDef => !!d)
  }

  add(input: AddInput): TaskDef {
    const s = this.settings
    const threads = input.threads ?? s.threads
    const dest = this.resolveDest(input.url, input.dest || s.download_dir)
    const d: TaskDef = {
      id: randomBytes(6).toString('hex'),
      url: input.url,
      dest,
      threads,
      proxy: s.proxy,
      added_at: Date.now() / 1000,
      note: input.note?.trim() ?? '',
    }
    this.register(d)
    this.persist(this.listDefs())
    this.start(d.id)
    return d
  }

  /** dest 指向目录时用 URL 文件名补全成完整文件路径。 */
  private resolveDest(url: string, dest: string): string {
    if (!dest) return dest
    // 判断「是不是目录」不能只看结尾分隔符：默认保存目录是 ~/Downloads，
    // 没有尾部斜杠。把它当文件路径会让引擎下完 100% 后 rename 到已存在目录上失败。
    // 与 Python 版的 Path(dest).is_dir() 判断保持一致。
    const isDir = dest.endsWith('/') || dest.endsWith('\\') || isDirectory(dest)
    if (!isDir) return dest
    const name = basename(new URL(url).pathname) || 'download'
    return join(dest, decodeURIComponent(name))
  }

  /** 从队列里取一个待启动任务开始跑。 */
  start(id: string): void {
    const d = this.defs.get(id)
    if (!d) return
    const task = this.tasks.get(id)
    // 已有实例：正常状态不用管；失败/取消的实例已经死透了，等于重试
    if (task) {
      if (task.state === 'error' || task.state === 'cancelled') this.retry(id)
      return
    }
    this.startOne(d)
  }

  private startOne(d: TaskDef): void {
    const task = new EngineTask(d.url, d.dest, d.threads, d.proxy, this.settings.user_agent)
    this.tasks.set(d.id, task)
    // 引擎回调在子进程的 stdout 事件里触发，这里只收集快照后推送给 UI
    task.onProgress = () => this.pushProgress(d.id)
    task.run()
  }

  private pushProgress(id: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    this.onPush({ taskId: id, snapshot: task.snapshot() })
  }

  pause(id: string): void {
    this.tasks.get(id)?.pause()
  }

  resume(id: string): void {
    const task = this.tasks.get(id)
    if (!task) {
      this.start(id)
      return
    }
    if (task.state === 'paused') {
      task.resume() // 引擎自己会重算偏移并续传
    } else if (task.state === 'error' || task.state === 'cancelled') {
      // 失败/取消的实例进程已经死透，不能只改内存状态就再 run()——那样会拿
      // 上一次失败的陈旧快照继续跑，还可能漏发 probe。跟 start() 一样走重试。
      this.retry(id)
      return
    }
    this.maybeStart()
  }

  /** 失败任务重试：清掉旧实例从头开始。 */
  retry(id: string): void {
    const task = this.tasks.get(id)
    if (task) {
      this.shutdownTask(task)
      this.tasks.delete(id)
    }
    const d = this.defs.get(id)
    if (d) this.startOne(d)
    this.maybeStart()
  }

  setThreads(id: string, n: number): void {
    this.tasks.get(id)?.setThreads(n)
    const d = this.defs.get(id)
    if (d) d.threads = Math.max(1, Math.floor(n))
  }

  remove(id: string): void {
    const task = this.tasks.get(id)
    this.defs.delete(id)
    this.order = this.order.filter((x) => x !== id)
    this.tasks.delete(id)
    if (task) {
      if (task.state === 'downloading') {
        try {
          task.pause()
        } catch {
          // 忽略
        }
      }
      this.shutdownTask(task)
    }
    this.persist(this.listDefs())
    this.maybeStart()
  }

  clearFinished(): void {
    for (const id of this.order) {
      const snap = this.tasks.get(id)?.snapshot()
      if (snap?.state === 'done') this.remove(id)
    }
  }

  /** 停掉引擎并释放资源。Rust 引擎是子进程，不关会泄漏进程和管道。 */
  private shutdownTask(task: EngineTask): void {
    try {
      task.kill()
    } catch {
      // 忽略
    }
  }

  action(id: string, action: string): void {
    switch (action) {
      case 'start':
        this.start(id)
        break
      case 'pause':
        this.pause(id)
        break
      case 'resume':
        this.resume(id)
        break
      case 'delete':
        this.remove(id)
        break
      case 'cancel':
        this.remove(id)
        break
      default:
        break
    }
  }

  startAll(): void {
    this.maybeStart()
  }

  stopAll(): void {
    for (const [id, task] of this.tasks) {
      if (task.state === 'downloading') this.pause(id)
    }
  }

  actionAll(action: string): void {
    if (action === 'start') this.startAll()
    else if (action === 'pause') this.stopAll()
    else if (action === 'clear-finished') this.clearFinished()
  }

  running(): number {
    return [...this.tasks.values()].filter((t) => t.state === 'downloading').length
  }

  /** 把排队中的任务填到并发上限。 */
  private maybeStart(): void {
    const limit = Math.max(1, this.settings.max_concurrent)
    for (;;) {
      if (this.running() >= limit) return
      const tid = this.order.find((id) => this.defs.has(id) && !this.tasks.has(id))
      if (!tid) return
      this.startOne(this.defs.get(tid)!)
    }
  }

  snapshot(id: string): TaskSnapshot | null {
    return this.tasks.get(id)?.snapshot() ?? null
  }

  /** 给列表 UI 用的行数据。 */
  rows(): TaskRow[] {
    const out: TaskRow[] = []
    for (const id of this.order) {
      const d = this.defs.get(id)
      if (!d) continue
      out.push({ id, def: d, snap: this.tasks.get(id)?.snapshot() ?? null })
    }
    return out
  }

  statusCounts(): StatusCounts {
    const counts: StatusCounts = {
      downloading: 0,
      paused: 0,
      queued: 0,
      done: 0,
      error: 0,
    }
    for (const id of this.order) {
      if (!this.defs.has(id)) continue
      const t = this.tasks.get(id)
      if (t) {
        const st = t.state
        if (st === 'downloading' || st === 'paused' || st === 'done' || st === 'error') {
          counts[st] += 1
        } else {
          counts.queued += 1
        }
      } else {
        counts.queued += 1
      }
    }
    return counts
  }

  totalSpeed(): number {
    return [...this.tasks.values()]
      .filter((t) => t.state === 'downloading')
      .reduce((sum, t) => sum + (t.speed || 0), 0)
  }

  /** 引擎退出前统一停掉所有子进程，避免泄漏。 */
  shutdown(): void {
    for (const task of this.tasks.values()) this.shutdownTask(task)
    this.tasks.clear()
  }
}
