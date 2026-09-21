// 注册 / 注销 FastDrop native messaging 宿主（Windows HKCU）。
//
// 浏览器（Chrome/Edge）在 Windows 上只从注册表找宿主 manifest：
//   HKCU\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\com.fastdrop.host
//   HKCU\SOFTWARE\Google\Chrome\NativeMessagingHosts\com.fastdrop.host
// （以及 Chromium 作为 Edge 的兜底）——键的默认值指向一个 JSON manifest 文件。
//
// manifest 里 "path" 指向宿主二进制（打包后是 fastdrop.exe 自己，
// 开发模式是 electron.exe + app 目录）。"allowed_origins" 只放本扩展的 ID：
//   chrome-extension://gnlgecbjgmkieigjojcpifcjncmjjecj/
// 开发期用固定 key 锁定这个 ID（见 extension/manifest.json 的 "key"）。
//
// HKCU 下写注册表不需要管理员权限，也只影响当前用户，注销干净利落。
//
// 用法：
//   node scripts/register-host.mjs install   <host-path> <extension-id>
//   node scripts/register-host.mjs uninstall
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOST_NAME = 'com.fastdrop.host'
const HERE = dirname(fileURLToPath(import.meta.url))
// manifest 放在注册表之外的用户数据目录，避免和 app 的安装目录纠缠
const MANIFEST_DIR = join(process.env.APPDATA || '', 'FastDrop')
const MANIFEST_FILE = join(MANIFEST_DIR, `${HOST_NAME}.json`)

const REG_ROOTS = [
  ['Edge', 'SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts'],
  ['Chrome', 'SOFTWARE\\Google\\Chrome\\NativeMessagingHosts'],
  ['Chromium', 'SOFTWARE\\Chromium\\NativeMessagingHosts'],
]

function regAdd(key) {
  execFileSync('reg', ['add', key, '/ve', '/d', MANIFEST_FILE, '/f'], { stdio: 'pipe' })
}

function regDel(key) {
  execFileSync('reg', ['delete', key, '/f'], { stdio: 'pipe' })
}

function makeManifest(hostPath, extensionId) {
  mkdirSync(MANIFEST_DIR, { recursive: true })
  const manifest = {
    name: HOST_NAME,
    description: 'FastDrop 下载助手宿主',
    path: hostPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  }
  writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2), 'utf8')
}

function install(hostPath, extensionId) {
  if (!hostPath) throw new Error('缺少宿主路径：node register-host.mjs install <host-path> <extension-id>')
  if (!/^[a-p]{32}$/.test(extensionId || '')) throw new Error('扩展 ID 不合法（应为 32 位 a–p 字母）')
  if (!existsSync(hostPath)) throw new Error(`宿主二进制不存在：${hostPath}`)
  makeManifest(hostPath, extensionId)
  for (const [name, root] of REG_ROOTS) {
    regAdd(`${root}\\${HOST_NAME}`)
    console.log(`registered ${name}: ${root}\\${HOST_NAME} -> ${MANIFEST_FILE}`)
  }
  console.log(`manifest: ${MANIFEST_FILE}`)
}

function uninstall() {
  for (const [name, root] of REG_ROOTS) {
    try {
      regDel(`${root}\\${HOST_NAME}`)
      console.log(`unregistered ${name}: ${root}\\${HOST_NAME}`)
    } catch {
      console.log(`${name}: key 不存在，跳过`)
    }
  }
  try {
    rmSync(MANIFEST_FILE, { force: true })
    console.log(`removed manifest: ${MANIFEST_FILE}`)
  } catch {
    // 文件不在就无所谓
  }
}

const [, , cmd, ...rest] = process.argv
if (cmd === 'install') install(rest[0], rest[1])
else if (cmd === 'uninstall') uninstall()
else {
  console.error('用法：register-host.mjs install <host-path> <extension-id> | uninstall')
  process.exit(2)
}