/**
 * 任务调度器。
 *
 * 引擎只负责单个任务，这里负责全局调度：
 *   - 并发上限（同时最多几个任务在跑）
 *   - 排队 / 出队 / 重试
 *   - 把引擎回调转成推送到渲染进程
 *
 * Node 是单线程的，不需要显式互斥锁——
 * 主进程的事件循环就是唯一的执行上下文，不存在并发写。
 */
import { basename, dirname, extname, join } from 'node:path'
import { existsSync, rmSync, statSync, statfsSync } from 'node:fs'
import { EngineTask } from './engine'
import { randomBytes } from 'node:crypto'
import type {
  Settings,
  StatusCounts,
  TaskDef,
  TaskProgressPush,
  TaskRow,
  TaskSnapshot,
  TaskState,
} from '../shared/types'
import { isAutoResumable } from '../shared/types'
import { safeFileName, uniquePath } from './store'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * 磁盘预检留出的余量。贴着磁盘上限写完是不可能完成的任务：NTFS 自身要占簇、
 * 杀软和临时文件也在写。宁可提前一步停下来告诉用户，也不要写到一半 ENOSPC
 * 把 .part 写成半截。
 */
const SPACE_RESERVE = 256 * 1024 * 1024

export interface AddInput {
  url: string
  dest: string
  threads?: number
  note?: string
  /** 期望校验和原文（`sha256:<hex>` 或裸十六进制）。由 IPC 层校验后传进来。 */
  checksum?: string
}

/** add 的结果：duplicate=true 表示列表里本来就有这个链接，没有新建任务。 */
export interface AddOutcome {
  def: TaskDef
  duplicate: boolean
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

/**
 * 路径所在盘的可用字节数；拿不到返回 null（调用方据此放弃预检，不能反过来
 * 因为读不到就拦下正常下载）。
 *
 * bavail 是「当前用户可用的簇数」、bsize 是簇大小。实测 Windows 下
 * bavail*bsize 与 Get-CimInstance Win32_LogicalDisk 的 FreeSpace 完全相等
 * （D: 681262497792 字节分毫不差），所以不需要按平台分支。
 * 路径还没建出来时逐级上溯到最近的已存在祖先——要下载的那个文件本来就不存在。
 */
function freeBytesAt(p: string): number | null {
  let dir = p
  for (let i = 0; i < 12; i++) {
    try {
      const s = statfsSync(dir)
      if (!s.bsize || !Number.isFinite(s.bavail)) return null
      return s.bavail * s.bsize
    } catch {
      const parent = dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
  }
  return null
}

/**
 * 删单个文件，只删普通文件。
 *
 * 引擎子进程刚被杀掉时 Windows 可能还压着句柄，直接 rmSync 会 EPERM——所以
 * 重试几次。全失败才回报错误，绝不静默：用户要靠这个判断磁盘上还剩多少东西。
 */
async function removeFile(p: string): Promise<string | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      if (!existsSync(p)) return null
      if (!statSync(p).isFile()) return `${basename(p)} 不是文件，已跳过`
      rmSync(p)
      return null
    } catch (e) {
      if (attempt === 3) return `${basename(p)}：${e instanceof Error ? e.message : String(e)}`
      await sleep(120)
    }
  }
  return null
}

/**
 * URL 里取文件名。引擎侧只接受完整文件路径（它自己不会从 URL 推文件名），
 * 所以这里是唯一的推导点：URL 非法时也不能抛，退化成去掉 query 后的尾段。
 */
function fileNameFromUrl(url: string): string {
  let path = ''
  try {
    path = new URL(url).pathname
  } catch {
    const cut = url.search(/[?#]/)
    path = cut >= 0 ? url.slice(0, cut) : url
  }
  return basename(path)
}

/** 调度中心：持有任务定义表、运行中的引擎实例、排队顺序。 */
export class Manager {
  settings: Settings
  private defs = new Map<string, TaskDef>()
  private tasks = new Map<string, EngineTask>()
  private order: string[] = []
  private onPush: (p: TaskProgressPush) => void
  private persist: PersistFn
  /** 正在退出：kill() 引发的 cancelled 不落盘，见 syncDef */
  private closing = false
  /**
   * 终态回调（done / error 各一次）。系统通知挂在这里，而不是让渲染进程
   * 自己从进度推送里猜「它刚才是不是下完了」——窗口藏在托盘时根本没有渲染
   * 进程的事件循环在关心这件事，猜出来的时机也不准。
   */
  onTerminal?: (row: TaskRow) => void
  /** 已经为哪个终态通知过用户。重新跑起来会清掉，所以下一次终态还会再通知。 */
  private notified = new Map<string, TaskState>()
  /** 已经做过磁盘预检的任务。每次 startOne 清空，腾出空间后重试会重新检查。 */
  private spaceChecked = new Set<string>()

  constructor(
    settings: Settings,
    onPush: (p: TaskProgressPush) => void,
    persist: PersistFn = () => {},
    initialDefs: TaskDef[] = [],
  ) {
    this.settings = settings
    this.onPush = onPush
    this.persist = persist
    for (const d of initialDefs) this.register(this.reconcileLegacy(d))
  }

  /**
   * 老版本（不持久化状态）留下的 tasks.json 里，已完成的任务看起来像"从没跑过"，
   * 于是会被重新拉起、把磁盘上的文件再下一遍并覆盖掉——实测过真实损失。
   * 引擎只把成品在 `.part` 全部写完后 rename 到 dest，所以「dest 已经是个文件
   * 且没有并存的 .part」就等于上一次下载已经完成，直接认成 done。
   */
  private reconcileLegacy(d: TaskDef): TaskDef {
    if (d.state !== '' || !d.dest || !existsSync(d.dest) || existsSync(`${d.dest}.part`)) return d
    const size = statSync(d.dest).size
    return { ...d, state: 'done', total: size, downloaded: size }
  }

  /** 注册任务定义。persist 时按 order 顺序落盘。 */
  private register(d: TaskDef): void {
    this.defs.set(d.id, d)
    if (!this.order.includes(d.id)) this.order.push(d.id)
  }

  listDefs(): TaskDef[] {
    return this.order.map((id) => this.defs.get(id)).filter((d): d is TaskDef => !!d)
  }

  add(input: AddInput): AddOutcome {
    const s = this.settings
    const url = input.url.trim()
    // 同一个链接重复添加（页面里连点两次下载是最常见的操作）不该产生第二个
    // 引擎进程去写同一个目标文件——两个进程同时写一份 .part 会互相踩坏。
    const existing = this.listDefs().find((d) => d.url === url)
    if (existing) return { def: existing, duplicate: true }

    const threads = input.threads ?? s.threads
    const dest = uniquePath(this.resolveDest(url, input.dest || s.download_dir))
    const d: TaskDef = {
      id: randomBytes(6).toString('hex'),
      url,
      dest,
      threads,
      proxy: s.proxy,
      added_at: Date.now() / 1000,
      note: input.note?.trim() ?? '',
      checksum: input.checksum ?? '',
      state: '',
      total: 0,
      downloaded: 0,
      error: '',
      finished_at: 0,
    }
    this.register(d)
    this.persist(this.listDefs())
    // 新任务交给调度器而不是直接 startOne：上限 3 时连点 4 次下载，
    // 第 4 个应该排队，而不是冲破并发限制一起抢带宽。
    this.maybeStart()
    return { def: d, duplicate: false }
  }

  /** dest 指向目录时用 URL 文件名补全成完整文件路径。 */
  private resolveDest(url: string, dest: string): string {
    if (!dest) return dest
    // 判断「是不是目录」不能只看结尾分隔符：默认保存目录是 ~/Downloads，
    // 没有尾部斜杠。把它当文件路径会让引擎下完 100% 后 rename 到已存在目录上失败。
    // 引擎只吃完整文件路径，所以补全必须在这里做完。
    const isDir = dest.endsWith('/') || dest.endsWith('\\') || isDirectory(dest)
    if (!isDir) return dest
    return join(dest, safeFileName(fileNameFromUrl(url)))
  }

  /** 从队列里取一个待启动任务开始跑。 */
  start(id: string): void {
    const d = this.defs.get(id)
    if (!d) return
    const task = this.tasks.get(id)
    // 已有实例：paused 走恢复；error/cancelled 的实例已经死透了，直接 run()
    // 重新 spawn 一个进程——引擎 probe 会读回 .part 与 sidecar 从断点续传。
    // 这里绝不能走 retry()：那等于用户点个「开始」就把下了 90% 的文件删了重下。
    if (task) {
      if (task.state === 'paused') this.resume(id)
      else task.run()
      return
    }
    // 已完成的不在这里重跑：重跑等于把磁盘上的成品重新下一遍再覆盖掉。
    // 真的要重新下载走 retry()（UI 上「重新下载」）。
    if (d.state === 'done') return
    this.startOne(d)
  }

  private startOne(d: TaskDef): void {
    // 代理取当前设置而不是 d.proxy：TaskDef 里那份是「添加任务那一刻」的快照，
    // 用户后来在设置里改了代理（这正是他被卡住之后唯一会去做的事），
    // 老任务还在用旧值，表现就是「改了代理没反应」。
    const task = new EngineTask(d.url, d.dest, d.threads, this.settings.proxy, this.settings.user_agent)
    d.proxy = this.settings.proxy
    // 限速与校验和是「这一轮下载」的参数，必须在 spawn 前就位：EngineTask.run()
    // 一进来就把 probe 命令写进 stdin，之后再赋值只能影响下一轮。
    task.rateLimitKbps = this.settings.rate_limit_kbps
    task.checksum = d.checksum
    this.tasks.set(d.id, task)
    // 每一轮启动重新做一次磁盘预检：用户可能就是按着提示刚腾出空间来点「继续」的。
    this.spaceChecked.delete(d.id)
    task.onProgress = () => this.onEngineProgress(d, task)
    // 预检的真正关口：probe 报回长度之后、run 预分配 .part 之前。
    // 每次 probe 都重算一遍——用户可能就是照着上一轮的提示腾出了空间，
    // 拿「这个任务早查过了」当理由跳过，等于告诉人家「腾了也没用」。
    task.onProbed = () => {
      this.spaceChecked.delete(d.id)
      this.checkDiskSpace(d, task)
    }
    // 状态一变做两件事：把状态写回定义并落盘（重启后才知道它已经完成），
    // 再重新看一遍调度——done/error 占着 `tasks` 但不再计入 `running()`，
    // 必须在这里把腾出来的槽位还给排队任务。漏掉这一步，
    // max_concurrent=3 下排第 4 个任务就会永远卡在「排队中」。
    task.onState = () => {
      this.syncDef(d, task)
      this.maybeStart()
    }
    task.run()
  }

  /**
   * 引擎的进度回调。除了转发，还要做磁盘预检——这是唯一知道「文件到底多大」
   * 的时机（添加任务时只有 URL，探测完才有 total）。
   */
  private onEngineProgress(d: TaskDef, task: EngineTask): void {
    this.pushProgress(d.id)
    this.checkDiskSpace(d, task)
  }

  /**
   * 第一次拿到文件总大小时，确认目标盘装得下，装不下就立刻停在这个断点上
   * 并给出可读原因。
   *
   * 为什么不等到写失败：一个 8 GB 的合集下到 7.9 GB 才 ENOSPC，用户既浪费了
   * 前面的全部时间，`.part` 还停在半截状态。而为什么不放在新建任务时检查：
   * 那一刻只有 URL，文件大小未知，任何「先报个空间不足」都只能靠猜。
   */
  private checkDiskSpace(d: TaskDef, task: EngineTask): void {
    const snap = task.snapshot()
    // total <= 0 有两种来源：还没 probe 出来，以及服务器压根不报长度（chunked）。
    // 后者永远拿不到长度，预检只能跳过——这不是漏检，是信息不足时唯一诚实的做法：
    // 拿 0 当「装得下」会让写满盘重新变成一次静默失败，拿猜的值当长度则会拦掉
    // 明明装得下的下载。引擎在这种任务上不会 set_len 预分配，只会边下边写。
    if (snap.total <= 0 || this.spaceChecked.has(d.id)) return
    this.spaceChecked.add(d.id)
    const free = freeBytesAt(d.dest)
    if (free === null) return // 读不到可用空间就不拦，不能让预检本身制造失败
    const need = Math.max(0, snap.total - snap.downloaded) + SPACE_RESERVE
    if (need <= free) return
    // 文案保持英文并与引擎同源（not enough space），渲染层 errors.ts 会翻成中文
    // 并给建议；这里 kill 而丢弃进度，所以用户腾出空间后点「继续下载」能接着下。
    task.fail(
      `not enough space on disk: need ${need} bytes, only ${free} bytes free in ${dirname(d.dest)}`,
    )
  }

  /**
   * 把引擎的实时状态折回任务定义并落盘。
   * 退出时 kill() 会把每个在跑的任务改成 cancelled，那是关窗的副作用而不是
   * 任务自己的结局——写进盘里会让下次启动不再自动续传，所以这里跳过。
   */
  private syncDef(d: TaskDef, task: EngineTask): void {
    const snap = task.snapshot()
    if (this.closing && snap.state === 'cancelled') return
    d.state = snap.state
    d.total = snap.total
    d.downloaded = snap.downloaded
    d.error = snap.error
    d.finished_at = snap.finished_at
    this.persist(this.listDefs())
    this.pushProgress(d.id)
    this.notifyTerminal(d.id, snap.state)
  }

  /**
   * done / error 各通知一次，且不重复。
   *
   * 去重是必需的：引擎的终态可能先由一条带该状态的 progress 报上来、再由
   * done/error 事件补一次（forceState 的两条回调路径），渲染侧还会轮询刷新。
   * 中途重新跑起来则清掉记录，这样「重试后又失败」仍然会再通知一次。
   */
  private notifyTerminal(id: string, state: TaskState): void {
    if (state !== 'done' && state !== 'error') {
      this.notified.delete(id)
      return
    }
    if (this.notified.get(id) === state) return
    const def = this.defs.get(id)
    if (!def) return
    this.notified.set(id, state)
    this.onTerminal?.({ id, def, snap: this.snapshot(id) })
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
    } else {
      // 失败/取消的实例进程已经死透：run() 会重新 spawn 并从 .part 续传。
      // 不能走 retry()——那是「重新下载」，会把已下的部分删掉从头再来。
      task.run()
    }
    this.maybeStart()
  }

  /** 失败任务重试 / 已完成任务重新下载：清掉旧实例与持久化进度，从头开始。 */
  retry(id: string): void {
    const task = this.tasks.get(id)
    if (task) {
      // 唯一该放弃断点的路径：让引擎删掉 .part 与 sidecar，重新下是一份新文件。
      this.shutdownTask(task, true)
      this.tasks.delete(id)
    }
    const d = this.defs.get(id)
    if (!d) return
    d.state = ''
    d.downloaded = 0
    d.error = ''
    d.finished_at = 0
    this.startOne(d)
    this.maybeStart()
  }

  setThreads(id: string, n: number): void {
    this.tasks.get(id)?.setThreads(n)
    const d = this.defs.get(id)
    if (!d) return
    d.threads = Math.max(1, Math.floor(n))
    // 没有活着的实例时，新线程数只存在于内存；不落盘的话重启就回到旧值。
    this.persist(this.listDefs())
  }

  /**
   * 给一个已经在列表里的任务设校验和。
   *
   * 必须能事后补：从游戏站点进来的任务八成是捕获桥建的，那一刻用户只点了一下
   * 下载按钮，站点页面上的 md5 是之后才看到的。没有这条路径，校验和就等于
   * 「新建任务时忘了填，这一份十几个 GB 就再也验不了了」。
   *
   * 生效时机是「下一轮下载」，不是当前这一轮：引擎在 spawn 时就把 checksum 读走了
   * （`run` 命令的参数），所以界面上写「改动下一轮下载才生效」是准确的。
   */
  setChecksum(id: string, checksum: string): void {
    const d = this.defs.get(id)
    if (!d) return
    d.checksum = checksum
    // 必须同时写进活着的 EngineTask：它持有的是 startOne 时拷走的一份值，而失败的
    // 实例并不会被丢出 `tasks`——用户点「继续下载」走的是 task.run()，用的是实例上
    // 那个旧值。不同步就等于「事后补的校验和永远不生效」：补了正确的 md5，下一轮
    // 仍按原来的错值判失败，用户只会看到同一个「对不上」重复出现。
    const task = this.tasks.get(id)
    if (task) task.checksum = checksum
    this.persist(this.listDefs())
    this.pushProgress(id)
  }

  /**
   * 换上一份新设置，并把限速与网络出口立刻推给已知的任务实例。
   *
   * 必须走这里而不是让调用方直接改 `manager.settings`：用户点「保存」时往往
   * 有三个任务正在全速下，只改内存里的字段等于要等下次重启才生效，而界面已经
   * 显示新数值了——看起来就是「设了没用」。EngineTask.setRate 对已死的进程是
   * 空操作但会记住数值，下次 probe/run 自然带上，所以全覆盖到就够了。
   *
   * 代理/UA 同理，而且它比限速更容易被用户撞上：任务失败 → 去设置里填代理 →
   * 回来点「继续下载」，走的是同一个实例的 run()。不同步的话这一串操作下来
   * 错误还是原样那句 403，用户只会认为「填了代理没用」。
   */
  applySettings(next: Settings): void {
    const rateChanged = next.rate_limit_kbps !== this.settings.rate_limit_kbps
    const netChanged = next.proxy !== this.settings.proxy || next.user_agent !== this.settings.user_agent
    this.settings = next
    if (rateChanged) {
      for (const task of this.tasks.values()) task.setRate(next.rate_limit_kbps)
    }
    if (netChanged) {
      for (const [id, task] of this.tasks) {
        task.setNetworkConfig(next.proxy, next.user_agent)
        const d = this.defs.get(id)
        if (d) d.proxy = next.proxy
      }
      this.persist(this.listDefs())
    }
  }

  /**
   * 移除任务。deleteFiles=true 时连已落盘的成品和断点一起删。
   *
   * 默认仍然只删记录——界面上写着「磁盘上已下载的文件不会删除」，那就得守。
   * 但光删记录会在磁盘上永远留下一个几百 MB 的 `.part`，用户既看不见也清不掉，
   * 所以把删文件做成显式选项（返回未能删除的路径原因，空数组 = 干净）。
   */
  async remove(id: string, deleteFiles = false): Promise<string[]> {
    const d = this.defs.get(id)
    const dest = d?.dest ?? ''
    const task = this.tasks.get(id)
    this.defs.delete(id)
    this.order = this.order.filter((x) => x !== id)
    this.tasks.delete(id)
    this.notified.delete(id)
    this.spaceChecked.delete(id)
    // 先停子进程再删文件：引擎还压着 .part 的句柄时删不掉。
    if (task) this.shutdownTask(task)
    this.persist(this.listDefs())
    this.maybeStart()
    if (!deleteFiles || !dest) return []
    const failures: string[] = []
    for (const p of [dest, `${dest}.part`, `${dest}.part.meta`]) {
      const why = await removeFile(p)
      if (why) failures.push(why)
    }
    return failures
  }

  async clearFinished(): Promise<void> {
    for (const id of [...this.order]) {
      if (this.resolvedState(id) === 'done') await this.remove(id)
    }
  }

  /**
   * 停掉引擎子进程。默认保留断点（kill）；只有 retry 传 discard=true
   * 让引擎删掉 .part 从头再下。Rust 引擎是子进程，不关会泄漏进程和管道。
   */
  private shutdownTask(task: EngineTask, discard = false): void {
    try {
      if (discard) task.discard()
      else task.kill()
    } catch {
      // 忽略
    }
  }

  /**
   * 单任务动作。移除和删文件不走这里——那是 removeTask 频道，
   * 因为它要 await 磁盘操作并把失败回报给界面。
   */
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
      case 'retry':
        this.retry(id)
        break
      default:
        break
    }
  }

  /** 任务是否存在（IPC 层用来把「点了个不存在的 id」报成可读错误）。 */
  has(id: string): boolean {
    return this.defs.has(id)
  }

  /**
   * 启动后补跑：把上次被强杀/崩溃留下的未完成任务重新拉起来续传。
   * 不动 paused —— 那是用户主动按的暂停，重启后该保持。
   */
  startQueued(): void {
    this.maybeStart()
  }

  startAll(): void {
    // 已暂停的先唤醒：maybeStart 只补空槽，不会把 paused 拉回来（那是用户
    // 主动按暂停的，重启后也该保持暂停）。
    for (const id of [...this.order]) {
      if (this.resolvedState(id) === 'paused') this.resume(id)
    }
    this.maybeStart()
  }

  stopAll(): void {
    for (const [id, task] of this.tasks) {
      if (task.state === 'downloading') this.pause(id)
    }
  }

  /**
   * 一键重试所有失败/被取消的任务，从断点续传。
   *
   * 这里刻意用 start 而不是 retry：retry 的语义是「放弃已有进度从头再下」，
   * 一次网络抖动就让人重下 8 GB 是灾难。start 会让引擎重新 probe 并读回
   * .part 与 sidecar，接着下已经下好的部分。
   */
  retryFailed(): void {
    for (const id of [...this.order]) {
      const st = this.resolvedState(id)
      if (st === 'error' || st === 'cancelled') this.start(id)
    }
    this.maybeStart()
  }

  async actionAll(action: string): Promise<void> {
    if (action === 'start') this.startAll()
    else if (action === 'pause') this.stopAll()
    else if (action === 'retry-failed') this.retryFailed()
    else if (action === 'clear-finished') await this.clearFinished()
  }

  running(): number {
    return [...this.tasks.values()].filter((t) => t.state === 'downloading').length
  }

  /** 把排队中的任务填到并发上限。 */
  private maybeStart(): void {
    const limit = Math.max(1, this.settings.max_concurrent)
    for (;;) {
      if (this.running() >= limit) return
      // 只挑"确实还欠着一次下载"的定义。以前这里只看有没有实例，于是每次
      // 任何任务状态变化都会把历史任务（包括早就下完的）重新拉起从头下。
      const tid = this.order.find((id) => {
        const d = this.defs.get(id)
        return d && !this.tasks.has(id) && isAutoResumable(d.state)
      })
      if (!tid) return
      this.startOne(this.defs.get(tid)!)
    }
  }

  snapshot(id: string): TaskSnapshot | null {
    const task = this.tasks.get(id)
    if (task) return task.snapshot()
    return restoredSnapshot(this.defs.get(id) ?? null)
  }

  /** 给列表 UI 用的行数据。 */
  rows(): TaskRow[] {
    const out: TaskRow[] = []
    for (const id of this.order) {
      const d = this.defs.get(id)
      if (!d) continue
      const task = this.tasks.get(id)
      out.push({ id, def: d, snap: task ? task.snapshot() : restoredSnapshot(d) })
    }
    return out
  }

  /** 有实例用实例的实时状态，没有就用落盘的状态——重启后不再一律显示「排队中」。 */
  private resolvedState(id: string): TaskState | '' {
    const task = this.tasks.get(id)
    if (task) return task.state
    return this.defs.get(id)?.state ?? ''
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
      const st = this.resolvedState(id)
      if (st === 'downloading' || st === 'paused' || st === 'done' || st === 'error') {
        counts[st] += 1
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
    this.closing = true
    for (const task of this.tasks.values()) this.shutdownTask(task)
    this.tasks.clear()
  }
}

/**
 * 重启后、引擎还没拉起来时的占位快照：让列表显示落盘的状态与进度，
 * 而不是把已完成的任务画成「排队中 0%」。从未跑过的任务仍然返回 null。
 */
function restoredSnapshot(d: TaskDef | null): TaskSnapshot | null {
  if (!d || !d.state || d.state === 'queued') return null
  const total = d.total
  const downloaded = Math.min(d.downloaded, total || d.downloaded)
  return {
    url: d.url,
    dest: d.dest,
    filename: basename(d.dest),
    total,
    downloaded,
    progress: total > 0 ? Math.min(1, downloaded / total) : 0,
    speed: 0,
    eta: 0,
    state: d.state,
    error: d.error,
    threads: d.threads,
    segments: [],
    finished_at: d.finished_at,
    // 校验只发生在下载的那个子进程里；没有实例时不可能还在算哈希。
    verifying: false,
  }
}

