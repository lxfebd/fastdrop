/**
 * 宿主自动注册（Windows）：让浏览器（Edge/Chrome/Chromium）能找到 FastDrop。
 *
 * 浏览器在 Windows 上**只**从注册表发现 native messaging host：
 *   HKCU\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\<name>
 *   HKCU\SOFTWARE\Google\Chrome\NativeMessagingHosts\<name>
 *   HKCU\SOFTWARE\Chromium\NativeMessagingHosts\<name>
 * 键的默认值指向一个 JSON manifest，manifest 里 "path" 是宿主可执行文件。
 *
 * 为什么由独立 host 而不是 Electron 自己当：扩展一发 sendNativeMessage，
 * 浏览器用 `chrome-extension://<id>` 当 argv[0] 拉起 **manifest.path 指向的
 * 可执行文件**。Electron 在这种启动下 app ready 不可靠、ready 前任何原生
 * 调用（http/spawn/readSync）都触发 Chromium CHECK 崩溃（实测）。
 * Rust host（resources/fastdrop-host.exe）没有这一层，读帧/HTTP/拉起主实例
 * 全是原生直连（见 engine-rs/src/host.rs）——IDM / Motrix 同款架构。
 *
 * 只对打包产物生效（app.isPackaged）：开发模式 process.execPath 是
 * electron.exe，它需要 app 路径参数，浏览器拉不起来，注册了也是错的——
 * dev 侧用 scripts/register-host.mjs（包装宿主）手动注册。
 */
import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const HOST_NAME = 'com.fastdrop.host'

/**
 * 扩展 ID。dev sideload 用固定 key 锁死（见 extension/manifest.json 的 "key"），
 * 所以打包应用和扩展的 ID 一致。将来上架商店后 ID 会变：把商店 ID 也加进来，
 * 一个宿主同时服务多个版本的扩展没有坏处。
 */
export const EXTENSION_IDS = ['gnlgecbjgmkieigjojcpifcjncmjjecj']

const REG_ROOTS = [
  'SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts',
  'SOFTWARE\\Google\\Chrome\\NativeMessagingHosts',
  'SOFTWARE\\Chromium\\NativeMessagingHosts',
]

function manifestPath(): string {
  return join(app.getPath('userData'), `${HOST_NAME}.json`)
}

/** 写 manifest + 写三个注册表键。只做打包环境；失败降级（记日志，不拦启动）。 */
export function registerNativeHost(): void {
  if (process.platform !== 'win32') return
  if (!app.isPackaged) {
    // dev 模式：electron.exe 当不了宿主（见文件头），交给 scripts/register-host.mjs
    return
  }
  try {
    // host 是独立 Rust 可执行文件，与引擎并列放 resources/（见 electron-builder.yml
    // extraResources；hostRegister 的宿主分支不再需要——manifest path 直接指向它）。
    const hostPath = join(process.resourcesPath, 'fastdrop-host.exe')
    const manifest = {
      name: HOST_NAME,
      description: 'FastDrop 下载助手宿主',
      path: hostPath,
      type: 'stdio',
      allowed_origins: EXTENSION_IDS.map((id) => `chrome-extension://${id}/`),
    }
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(manifestPath(), JSON.stringify(manifest, null, 2), 'utf8')
    for (const root of REG_ROOTS) {
      execFileSync('reg', ['add', `HKCU\\${root}\\${HOST_NAME}`, '/ve', '/d', manifestPath(), '/f'], {
        stdio: 'pipe',
      })
    }
    console.log(`[host] native messaging 宿主已注册：${process.execPath}`)
  } catch (e) {
    // 注册表被组策略锁住、磁盘只读之类都能让这里抛；浏览器扩展是锦上添花，
    // 不能因为写不进去就挡住正常启动。
    console.error('[host] 宿主注册失败（扩展可能连不上，不影响本体）：', e)
  }
}