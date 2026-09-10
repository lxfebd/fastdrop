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
  }
}

/** 包装单个任务的引擎子进程。对外接口与老 RustTask 一致。 */
export class EngineTask {
  state: TaskSnapshot['state'] = 'idle'
  error = ''
  speed = 0

  onState?: (task: EngineTask) => void
  onProgress?: (task: EngineTask) => void

  private proc: ChildProcess | null = null
  private snap: TaskSnapshot | null = null
  private alive = false
  private writeBuf: Buffer[] = []
  private pending = false
  private stdoutBuf = ''

  constructor(
    public readonly url: string,
    public readonly dest: string,
    public threads: number,
    public readonly proxy = '',
    public readonly userAgent = '',
  ) {}

  snapshot(): TaskSnapshot {
    return this.snap ?? emptySnap(this.url, this.dest, this.state)
  }

  private spawnProc(): void {
    if (this.proc) return
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

    // Rust 引擎的 stderr 是诊断信息（HTTP 错误、panic），收集起来便于排错。
    proc.stderr?.on('data', (d: Buffer) => {
      appendFileSync(logPath(), `[engine ${this.url.slice(0, 80)}] ${d.toString('utf8')}`)
    })

    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => this.onStdout(chunk))

    proc.on('error', (e) => {
      this.error = `引擎启动失败: ${e.message}`
      this.setState('error')
    })
    proc.on('close', () => {
      this.alive = false
      this.proc = null
      // 子进程意外退出（非 stop 触发）视为失败
      if (this.state !== 'done' && this.state !== 'cancelled') {
        this.setState('error')
      }
    })
  }

  /** 引擎里 probe 和 run 是两条命令：probe 只算分段和续传偏移，
   *  状态停在 idle；要真正开始得再发 run。 */
  run(): void {
    if (this.state === 'downloading' || this.state === 'done') return
    this.error = ''
    this.spawnProc()
    if (this.state === 'error') return
    this.setState('preparing')
    try {
      if (!this.snap?.total) {
        this.send({
          cmd: 'probe',
          url: this.url,
          dest: this.dest,
          threads: this.threads,
          proxy: this.proxy,
          user_agent: this.userAgent,
        })
      }
      this.send({ cmd: 'run' })
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

  stop(): void {
    this.sendStop()
    this.setState('cancelled')
  }

  /** 彻底终止子进程（放弃任务时用）。 */
  kill(): void {
    this.alive = false
    if (this.proc) {
      this.proc.kill()
      this.proc = null
    }
    this.setState('cancelled')
  }

  private sendStop(): void {
    try {
      this.send({ cmd: 'stop' })
    } catch {
      // 进程可能已经退出
    }
    this.proc?.kill()
    this.proc = null
    this.alive = false
  }

  /** 写一行命令到 stdin。引擎按行解析，不做流式。 */
  private send(cmd: EngineCommand): void {
    if (!this.proc || !this.proc.stdin || !this.proc.stdin.writable) {
      throw new Error('引擎进程不可用')
    }
    const line = Buffer.from(JSON.stringify(cmd) + '\n', 'utf8')
    this.writeBuf.push(line)
    if (this.pending) return
    this.pending = true
    setImmediate(() => {
      this.flush()
    })
  }

  private flush(): void {
    if (!this.proc || !this.proc.stdin) {
      this.pending = false
      return
    }
    for (const buf of this.writeBuf) {
      this.proc.stdin.write(buf)
    }
    this.writeBuf = []
    this.pending = false
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
        if (data.state) cur.state = data.state
        this.snap = cur
        if (data.state) {
          this.setState(data.state)
          if (this.state !== 'downloading') this.speed = 0
        } else {
          this.speed = Number(data.speed ?? 0) || 0
        }
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
          finished_at: Date.now() / 1000,
        }
        this.speed = 0
        this.setState('done')
        this.emitProgress()
        break
      }
      case 'error': {
        this.error = String(msg.error ?? '未知错误')
        this.setState('error')
        // 错误文案也要进快照，UI 靠它显示失败原因
        this.snap = { ...(this.snap ?? emptySnap(this.url, this.dest, 'error')), error: this.error }
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
