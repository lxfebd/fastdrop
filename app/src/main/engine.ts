/**
 * Rust 下载引擎封装。
 *
 * 通信协议是换行 JSON，稳定不变：
 *   - 每个任务一个独立 Rust 子进程（tokio + reqquest）
 *   - stdin 写一行 JSON 命令，stdout 读一行 JSON 事件
 *   - 先 probe（算分段 + 读断点）再 run；之后 pause/resume/stop/set_threads
 *
 * 为什么引擎单独跑进程：下载 I/O 密集，不放进 Electron 主进程才不会阻塞
 * UI 线程和 IPC 分发。Rust 进程本身是独立的，崩溃也只影响单个任务。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { EngineCommand, EngineEvent, TaskSnapshot } from '../shared/types'
import { engineProxyFor } from './netConfig'

const CHUNK = 64 * 1024

/** 定位 fastdrop-engine 可执行文件。 */
export function enginePath(): string {
  const root = dirname(process.env.FASTDROP_ROOT ?? process.cwd())
  const exe = process.platform === 'win32' ? 'fastdrop-engine.exe' : 'fastdrop-engine'
  // 打包后引擎和主进程同目录；开发时走 engine-rs/target/{release,debug}
  for (const p of [
    join(process.resourcesPath ?? '', exe),
    join(root, 'engine-rs', 'target', 'release', exe),
    join(root, 'engine-rs', 'target', 'debug', exe),
  ]) {
    if (existsSync(p)) return p
  }
  return join(root, 'engine-rs', 'target', 'release', exe)
}

function emptySnap(url: string, dest: string, state: string): TaskSnapshot {
  return {
    url,
    dest,
    filename: basename(dest),
    total: 0,
    downloaded: 0,
    progress: 0,
    speed: 0,
    eta: 0,
    state: state as TaskSnapshot['state'],
    error: '',
    threads: 0,
    segments: [],
    finished_at: 0,
    verifying: false,
  }
}

/** 包装单个任务的引擎子进程。对外接口与老 RustTask 一致。 */
export class EngineTask {
  state: TaskSnapshot['state'] = 'idle'
  error = ''
  speed = 0

  onState?: (task: EngineTask) => void
  onProgress?: (task: EngineTask) => void
  /** probe 报回长度、还没发 run 时被叫一次：主进程在这里做磁盘预检并决定是否放行。 */
  onProbed?: (task: EngineTask) => void

  private proc: ChildProcess | null = null
  private snap: TaskSnapshot | null = null
  private alive = false
  private pendingRun = false
  /** 当前这个子进程有没有已经 probe 过。换新进程必须重来——引擎是按命令记任务的。 */
  private probed = false
  private writeBuf: Buffer[] = []
  private draining = false
  private stdoutBuf = ''

  constructor(
    public readonly url: string,
    public readonly dest: string,
    public threads: number,
    /**
     * 用户在设置里填的代理原文（''=跟随系统代理）。不能直接下发给引擎：
     * 留空时要按目标地址问一次 Chromium（PAC 逐地址给结论），见 resolveThenSend()。
     *
     * 不能是 readonly：失败的任务实例不会被丢出 manager 的 tasks，用户点「继续下载」
     * 走的正是这个实例的 run()。构造期定死代理，等于让「被卡住 → 去设置里填代理 →
     * 点继续」这条最常见的自救路径永远下不动（第 4 轮 CDP 实测复现：改完代理点继续，
     * 引擎一路直连，错误还是那句 http 403）。
     */
    public proxySetting = '',
    public userAgent = '',
  ) {}

  /**
   * 换上当前设置里的代理与 UA。生效时机是「下一轮 probe/run」：
   * 正在跑的进程里 reqwest 的 client 已经建好了，换不了。
   */
  setNetworkConfig(proxySetting: string, userAgent: string): void {
    this.proxySetting = proxySetting
    this.userAgent = userAgent
  }

  /** 本轮实际生效的代理 URL，'' = 直连。run() 里解析出来，probe 命令带的是它。 */
  private effectiveProxy = ''

  /**
   * 建出「当前这条已探测计划」时用的网络出口（代理 + UA），probe 发出时记下。
   *
   * 为什么非得记：引擎的 reqwest client 只在 probe 时按代理建，`run` 命令里没有
   * 代理字段（引擎也读不到），而任务失败后子进程**不会退出**——于是「继续下载」
   * 会复用那个老 client。实测（隔离实验 fd_proxy_loop2）：同进程里先 probe 失败、
   * 再只发 run，代理命中数为 0，报错和上一轮一字不差。用户看到的正是
   * 「我按提示填了代理点了继续，怎么还是 403」。
   */
  private planNet = ''

  /** 出口指纹：代理 + UA。probe 与换进程判定必须用同一个算法，否则比对会长期错位。 */
  private netKey(): string {
    return `${this.effectiveProxy}\n${this.userAgent}`
  }

  /** 本任务限速，KiB/s，0 = 不限。改值要走 setRate()，才能立刻推给引擎。 */
  rateLimitKbps = 0
  /** 期望校验和，`算法:十六进制`；空串 = 下完不校验。 */
  checksum = ''

  snapshot(): TaskSnapshot {
    return this.snap ?? emptySnap(this.url, this.dest, this.state)
  }

  private spawnProc(): void {
    // 只认「确实还活着」的进程。子进程已经退出、close 事件却还没送达时，
    // 句柄是非空但管道是死的——这时必须重新 spawn，否则命令全丢进死管道。
    if (this.proc && this.proc.exitCode === null && this.proc.signalCode === null) {
      this.alive = true
      return
    }
    const exe = enginePath()
    if (!existsSync(exe)) {
      this.error = `Rust 引擎未找到: ${exe}`
      this.setState('error')
      return
    }
    const proc = spawn(exe, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // 不让子进程持有终端句柄，避免打包后残留窗口
      detached: false,
      windowsHide: true,
    })
    this.proc = proc
    this.alive = true
    // 新进程脑子里没有这个任务的任何上下文：不重新 probe 就发 run，它会当成
    // 「没我的事」而什么都不做，任务永远卡在准备中。
    this.probed = false
    // 上一任进程留下的半行不能拼到新进程的输出上
    this.stdoutBuf = ''
    this.writeBuf = []
    this.draining = false

    // Rust 引擎的 stderr 是诊断信息（HTTP 错误、panic），收集起来便于排错。
    proc.stderr?.on('data', (d: Buffer) => {
      appendFileSync(logPath(), `[engine ${this.url.slice(0, 80)}] ${d.toString('utf8')}`)
    })

    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => {
      if (this.proc === proc) this.onStdout(chunk)
    })

    // 往已死的管道写数据（例如刚 kill 完又发了一条命令）会异步抛 EPIPE。
    // 没有这个监听器就是 uncaughtException —— 整个主进程连同所有正在下载的任务
    // 一起没掉，一个任务的取消不该有这种代价。
    proc.stdin?.on('error', () => {
      this.writeBuf = []
    })

    proc.on('error', (e) => {
      if (this.proc !== proc) return
      this.error = `引擎启动失败: ${e.message}`
      this.setState('error')
    })
    proc.on('close', () => {
      // 只处理当前这个实例。retry 会先杀旧进程再立刻 spawn 新的，旧 child 的
      // close 事件晚一拍到达；不判断就会把新进程的句柄清掉，任务从此卡死。
      if (this.proc !== proc) return
      this.alive = false
      this.proc = null
      // 子进程意外退出（非 stop 触发）视为失败
      if (this.state !== 'done' && this.state !== 'cancelled') {
        this.setState('error')
      }
    })
  }

  /** 启动/恢复这一轮下载。真正发命令在 resolveThenSend() 里——代理要先按地址解析。 */
  run(): void {
    if (this.state === 'downloading' || this.state === 'done') return
    this.error = ''
    this.spawnProc()
    // 「引擎到底起没起来」只能看子进程，不能看状态。失败任务的状态本来就是 error，
    // 拿状态当闸门会让「继续下载」「全部开始」「重试全部失败」全部静默变成空操作，
    // 而 IPC 照样回 ok —— 用户看到的正是「点了没反应，按钮像坏的」。
    if (!this.alive) return
    this.setState('preparing')
    // 上一轮的失败原因不能留着：重下的一瞬间界面还写着「磁盘空间不足」，
    // 用户会以为点了没生效。状态已经是准备中了，理由就该清空，等新错误再说。
    if (this.snap && this.snap.error) {
      this.snap = { ...this.snap, error: '' }
    }
    void this.resolveThenSend()
  }

  /**
   * 发命令之前先把代理定下来。
   *
   * 两件事决定了不能拿构造时的值：
   * 1. 用户在设置里改完代理，下一个动作就该用新值——构造期定死的话，
   *    老任务会一路用旧代理直到进程结束；
   * 2. 「留空 = 跟随系统代理」在 Windows 上意味着注册表设置 + PAC + 按地址例外，
   *    只有 Chromium 知道结果，而那是异步的、逐目标地址的。
   */
  private async resolveThenSend(): Promise<void> {
    try {
      this.effectiveProxy = await engineProxyFor(this.url, this.proxySetting)
    } catch (e) {
      this.error = `代理配置没能生效：${e instanceof Error ? e.message : String(e)}`
      this.setState('error')
      return
    }
    // 出口和建计划时不一样就得换进程重探：老进程里的 client 是上一轮的代理建的，
    // run 命令改不动它（见 planNet 的注释）。terminate 不发 stop，断点保留。
    if (this.alive && this.probed && this.netKey() !== this.planNet) {
      this.terminate()
      this.spawnProc()
    }
    // 解析这一会儿用户可能已经点了暂停/取消，也可能进程已经退了
    if (!this.alive || this.state !== 'preparing') return
    this.sendStartCommands()
  }

  /** 引擎里 probe 和 run 是两条命令：probe 只算分段和续传偏移，
   *  状态停在 idle；要真正开始得再发 run。 */
  private sendStartCommands(): void {
    try {
      if (!this.probed) {
        // 这份计划（以及引擎里那个 client）就是用当前出口建出来的，记下来；
        // 下一轮出口变了就换进程重探，见 planNet。
        this.planNet = this.netKey()
        // probe 之后先停一手，等主进程回答「这块盘装得下吗」再发 run。
        // 引擎收到 run 干的第一件事就是把 .part 预分配成 total 那么大，
        // 等进度事件出来再拦，磁盘上已经躺着一个巨无霸了。
        this.pendingRun = true
        this.send({
          cmd: 'probe',
          url: this.url,
          dest: this.dest,
          threads: this.threads,
          proxy: this.effectiveProxy,
          user_agent: this.userAgent,
          rate_limit_kbps: this.rateLimitKbps,
          checksum: this.checksum,
        })
        return
      }
      // run 也带上限速与校验和：同一个子进程可能被 resume/pause 反复拉起，
      // 期间用户在设置里改过限速，只靠 probe 那条就把新值漏掉了。
      this.send({ cmd: 'run', rate_limit_kbps: this.rateLimitKbps, checksum: this.checksum })
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
      this.setState('error')
    }
  }

  /**
   * probe 报回长度之后的放行关口：先让主进程做磁盘预检，通过才真正开下。
   *
   * 这也是唯一能挡住「站点谎报 Content-Length」的位置——预分配一旦做了，
   * 轻则任务失败留下半截文件，重则把用户的盘撑到红线。
   */
  private confirmRun(): void {
    if (!this.pendingRun) return
    this.pendingRun = false
    this.probed = true
    this.onProbed?.(this)
    // 回调里可能就 fail() 了（磁盘装不下）：那时进程已被终止、状态已是 error，
    // 再发 run 等于对着一具尸体下命令。
    if (!this.alive || this.state === 'error' || this.state === 'cancelled') return
    try {
      // run 也带上限速与校验和：同一个子进程可能被 resume/pause 反复拉起，
      // 期间用户在设置里改过限速，只靠 probe 那条就把新值漏掉了。
      this.send({ cmd: 'run', rate_limit_kbps: this.rateLimitKbps, checksum: this.checksum })
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
      this.setState('error')
    }
  }

  pause(): void {
    if (this.state !== 'downloading' && this.state !== 'preparing') return
    this.setState('paused')
    try {
      this.send({ cmd: 'pause' })
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
      this.setState('error')
    }
  }

  resume(): void {
    this.run()
  }

  setThreads(n: number): void {
    this.threads = Math.max(1, Math.floor(n))
    if (!this.proc) return
    try {
      this.send({ cmd: 'set_threads', n: this.threads })
    } catch {
      // 引擎拒绝（例如分段不支持）就忽略，下次 probe 会重算
    }
  }

  /**
   * 改限速，KiB/s（0 = 不限）。
   *
   * 没有活进程时只记在字段上：下一条 probe/run 会带上它。发 set_rate 给一个
   * 已经退出的子进程只会写进死管道，那个成本是这个任务不该付的。
   */
  setRate(kbps: number): void {
    this.rateLimitKbps = Math.max(0, Math.floor(kbps))
    if (!this.proc) return
    try {
      this.send({ cmd: 'set_rate', rate_limit_kbps: this.rateLimitKbps })
    } catch {
      // 引擎版本不认识这条命令时会回 error，忽略即可：下次 probe 带上值
    }
  }

  /**
   * 终止子进程并保留断点（移除任务、退出程序都用它）。
   *
   * 这里绝不能发 `stop`：引擎侧 stop 的语义是「放弃下载」，它会删掉 .part 和
   * sidecar（engine-rs 的 discard_progress）。以前 kill() 无条件先发 stop，于是
   * 每次关窗退出都把正在下的文件连进度一起删干净，下次启动从零重下——用户说的
   * 「持久化不行、下过的重复下」就是这条。引擎每 100ms 自己落一次 sidecar，
   * 直接杀进程最多丢 100ms 的偏移量。
   */
  kill(): void {
    this.terminate()
    this.setState('cancelled')
  }

  /** 终止子进程但放弃已下进度：只有「重新下载」(retry) 该用。 */
  discard(): void {
    try {
      this.send({ cmd: 'stop' })
    } catch {
      // 进程可能已经退出
    }
    this.terminate()
    this.setState('cancelled')
  }

  /**
   * 由主进程判定失败（例如磁盘快满了，继续写下去只会写坏）。
   *
   * 保留断点：腾出空间后点「继续下载」应当接着下，而不是从零重下——所以这里
   * 走 kill 而不是 discard。error 必须先进快照再改状态，理由同 handleEvent 的
   * error 分支：反过来的话失败原因落不进盘。
   */
  fail(reason: string): void {
    if (this.state === 'done' || this.state === 'error') return
    this.terminate()
    this.error = reason
    this.snap = { ...(this.snap ?? emptySnap(this.url, this.dest, 'error')), error: reason }
    this.forceState('error')
    this.emitProgress()
  }

  private terminate(): void {
    this.alive = false
    this.writeBuf = []
    if (this.proc) {
      this.proc.kill()
      this.proc = null
    }
  }

  /**
   * 写一行命令到 stdin。引擎按行解析，不做流式。
   *
   * 必须同步落笔：调用方（stop/kill/pause）紧接着就 proc.kill()。
   * 之前这里把字节塞进 writeBuf、用 setImmediate 到下一个 tick 才写，于是
   * 「发 stop」和「杀进程」之间隔了一个事件循环轮次——stop 永远没机会进管道，
   * 引擎被 SIGTERM 直接打死，来不及把分段进度写回 .part.meta，重启后已下的
   * 部分只能重下。
   */
  private send(cmd: EngineCommand): void {
    const stdin = this.proc?.stdin
    if (!stdin || !stdin.writable) {
      throw new Error('引擎进程不可用')
    }
    this.writeBuf.push(Buffer.from(JSON.stringify(cmd) + '\n', 'utf8'))
    this.flush()
  }

  private flush(): void {
    const stdin = this.proc?.stdin
    if (!stdin || !stdin.writable) {
      // 进程没了，残留在缓冲里的命令也没有接收方了
      this.writeBuf = []
      return
    }
    while (this.writeBuf.length) {
      if (this.draining || !stdin.write(this.writeBuf[0])) {
        // 管道满：等 'drain' 再续写。没有 drain 监听就会一直漏写或重复挂监听。
        if (!this.draining) {
          this.draining = true
          stdin.once('drain', () => {
            this.draining = false
            this.flush()
          })
        }
        return
      }
      this.writeBuf.shift()
    }
  }

  /** 消费 stdout 的 JSON 事件，转成内存快照。 */
  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk
    let idx: number
    while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim()
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1)
      if (line) this.handleEvent(line)
    }
    // 防止进程退出前未 flush 的尾部
    if (this.stdoutBuf.length > CHUNK * 8) {
      this.stdoutBuf = this.stdoutBuf.slice(-CHUNK)
    }
  }

  private handleEvent(line: string): void {
    let msg: EngineEvent
    try {
      msg = JSON.parse(line) as EngineEvent
    } catch {
      return // 非 JSON 行（引擎的诊断输出）忽略
    }

    switch (msg.event) {
      case 'progress': {
        const data = msg.data ?? {}
        // preparing 阶段只发 {"state":"preparing"}，其余字段全缺。用空快照打底
        // 再覆盖，保证 UI 依赖的键永远存在——否则行刷新会在 snap.progress 上炸。
        const cur: TaskSnapshot = {
          ...emptySnap(this.url, this.dest, this.state),
          ...(this.snap ?? {}),
          ...data,
        }
        cur.url = cur.url || this.url
        cur.dest = cur.dest || this.dest
        cur.filename = cur.filename || basename(this.dest)
        cur.progress = Number(cur.progress) || 0
        cur.speed = Number(cur.speed) || 0
        cur.eta = Number(cur.eta) || 0
        cur.finished_at = Number(cur.finished_at) || 0
        cur.error = cur.error ?? ''
        cur.segments = cur.segments ?? []
        // 校验标志只认当前这一条应答，不继承上一条：preparing 的 ack 不带这个字段，
        // 用展开留下的旧值会让任务从上一轮就一直挂着「校验中」。
        cur.verifying = data.verifying === true
        if (data.state) cur.state = data.state
        this.snap = cur
        if (data.state) {
          // probe 回来的快照状态是 idle。但这一瞬我们其实正卡在「等主进程放行 run」
          // 上：状态要是退成排队中，用户在这毫秒级窗口点暂停会被 pause() 直接 return
          // 掉，命令却照样发出去——所以这一段对外一律显示准备中。
          const ns: TaskSnapshot['state'] =
            this.pendingRun && data.state === 'idle' ? 'preparing' : data.state
          cur.state = ns
          this.setState(ns)
          if (this.state !== 'downloading') this.speed = 0
        } else {
          this.speed = Number(data.speed ?? 0) || 0
        }
        // 只在「探测完成」那条快照上放行。引擎收到 probe 后先回一条只有
        // {"state":"preparing"} 的应答——它里面的 total 是从上一轮继承来的，
        // 拿它当放行时机等于让预检用旧长度把重下瞬间再拦一次，站点根本没被重新
        // 问过（用户腾完空间点继续，看到的还是同一条「磁盘空间不足」）。
        if (this.pendingRun && data.state === 'idle') this.confirmRun()
        this.emitProgress()
        break
      }
      case 'done': {
        const total = Number(msg.total || this.snap?.total || 0)
        this.snap = {
          ...(this.snap ?? emptySnap(this.url, this.dest, 'done')),
          downloaded: total,
          total,
          progress: 1,
          speed: 0,
          eta: 0,
          // done 之后不可能还在校验。不落 false 的话，界面会在「已完成」的任务上
          // 一直挂着「校验中」——而校验中是不给点暂停的。
          verifying: false,
          finished_at: Date.now() / 1000,
        }
        this.speed = 0
        this.forceState('done')
        this.emitProgress()
        break
      }
      case 'error': {
        this.error = String(msg.error ?? '未知错误')
        // 错误文案也要先进快照，再通知状态——反过来的话 onState 读到的还是旧快照，
        // 失败原因就落不到盘上，重启后列表只剩一个「失败」而没有为什么。
        // 校验失败也走这条：文件留着，进度留着，只把「校验中」摘掉。
        this.snap = {
          ...(this.snap ?? emptySnap(this.url, this.dest, 'error')),
          error: this.error,
          verifying: false,
        }
        this.forceState('error')
        this.emitProgress()
        break
      }
      default:
        break
    }
  }

  /**
   * 改状态。
   *
   * 除了更新内存里的 this.state，还必须把新状态同步回 this.snap：
   * snapshot() 返回的是缓存的快照，而 progress 事件在 preparing 阶段写进去的
   * state 是 'preparing'。如果只改 this.state，失败或暂停的任务在 UI 上会永远
   * 卡在「准备中」——用户看到引擎进程已经死透了，状态却纹丝不动。
   * speed 只在非下载态清零，避免把正在跑的实时速率抹掉。
   */
  private setState(next: TaskSnapshot['state']): void {
    if (this.state === next) return
    this.state = next
    this.snap = {
      ...(this.snap ?? emptySnap(this.url, this.dest, next)),
      state: next,
    }
    if (next !== 'downloading') this.snap.speed = 0
    this.onState?.(this)
  }

  /**
   * 终态专用通知：即使 this.state 已经是这个值，也照样回调一次 onState。
   *
   * 引擎经常先用一条 `{"state":"done"}` 的 progress 把状态报上来，随后的 done
   * 事件才补上完成时间。走 setState 的话第二次因为「状态没变」直接 return，
   * manager 就不会把 finished_at 落盘——重启后列表里的任务永远显示「完成于 –」。
   * error 同理：错误原因可能只在 error 事件里出现一次。
   */
  private forceState(next: TaskSnapshot['state']): void {
    this.state = next
    this.snap = {
      ...(this.snap ?? emptySnap(this.url, this.dest, next)),
      state: next,
    }
    if (next !== 'downloading') this.snap.speed = 0
    this.onState?.(this)
  }

  private emitProgress(): void {
    try {
      this.onProgress?.(this)
    } catch {
      // UI 回调不应影响下载本身
    }
  }
}

function logPath(): string {
  const dir = dataDir()
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // 忽略
  }
  return join(dir, '.engine-stderr.log')
}

/** 数据目录，固定为 ~/.fastdrop，保证任务/设置/断点文件跨版本通用。 */
export function dataDir(): string {
  if (process.env.FASTDROP_DATA_DIR) return process.env.FASTDROP_DATA_DIR
  return join(homedir(), '.fastdrop')
}

