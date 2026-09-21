/**
 * Native messaging 宿主模式的判定与帧协议参考实现。
 *
 * 宿主本身（读帧→投递→回帧）跑在 native-host-child.cjs——一个
 * ELECTRON_RUN_AS_NODE=1 的纯 Node 子进程，由 index.ts 的宿主分支拉起、
 * stdio 透传。为什么不在 Electron 主进程里做、以及 child 的职责划分，
 * 见 index.ts 宿主分支的注释与 native-host-child.cjs 的头部说明。
 *
 * 这里保留两件事：
 *   - isNativeHostMode：判定「浏览器用 chrome-extension:// 当 argv 拉起我们」
 *   - writeFrame / readFrame：帧协议的编解码参考实现，离线门用它验证
 *     协议本身（child 用同样的协议，两边一致就不会漂移）。
 *
 * 帧协议：4 字节小端 uint32 长度 + UTF-8 JSON。这是 Chromium native messaging
 * 的固定格式，浏览器侧 SDK 已经按它封包，host 侧必须原样解。长度上限 1 MB，
 * 浏览器不会发更大的帧；host 往 stdout 写超过 1 MB 会被浏览器掐掉连接。
 */
import { writeSync } from 'node:fs'

export const NATIVE_HOST_NAME = 'com.fastdrop.host'
const MAX_FRAME = 1024 * 1024
const URL_RE = /^(https?|ftp):\/\//i

/** 宿主 mode 的判定：argv 里带 `chrome-extension://<id>`（浏览器原生传参）。
 *  打包后这是 argv[1]；开发模式 electron 先吃一个 app 路径，标记退到 argv[2]。 */
export function isNativeHostMode(argv: string[]): boolean {
  for (let i = 1; i <= 2; i++) {
    if (typeof argv[i] === 'string' && argv[i].startsWith('chrome-extension://')) return true
  }
  return false
}

interface HostRequest {
  type?: unknown
  url?: unknown
  threads?: unknown
  note?: unknown
}

/** 写一帧。宿主走 fd 1 直写（浏览器只认 4 字节长度 + UTF-8 JSON）。 */
export function writeFrame(dst: NodeJS.WritableStream, obj: unknown): void {
  const text = JSON.stringify(obj)
  const buf = Buffer.alloc(4 + Buffer.byteLength(text))
  buf.writeUInt32LE(Buffer.byteLength(text), 0)
  buf.write(text, 4, 'utf8')
  if (dst === process.stdout) {
    writeSync(1, buf)
  } else {
    dst.write(buf)
  }
}

export interface FrameResult {
  message: HostRequest | null
  parseError?: string
}

/** 从一个完整 buffer 里解一帧（4 字节小端长度 + JSON）。 */
export function readFrame(raw: Buffer): FrameResult {
  if (raw.length < 4) return { message: null }
  const len = raw.readUInt32LE(0)
  const body = raw.subarray(4, 4 + len)
  if (body.length !== len) return { message: null }
  try {
    return { message: JSON.parse(body.toString('utf8')) as HostRequest }
  } catch {
    return { message: null, parseError: 'bad json in native messaging frame' }
  }
}