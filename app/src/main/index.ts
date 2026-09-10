/**
 * Electron 主进程入口。
 *
 * 职责：起窗口、管托盘、持有调度器、把任务事件透传给渲染进程。
 * 渲染进程不直接接触 Node 和文件系统——一切经由 preload 的 contextBridge。
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Ipc } from '../shared/ipc'
import { Manager } from './manager'
import { Store } from './store'
import { wireSites } from './sites/bridge'

/**
 * 主进程自己算 preload 路径。electron-vite 不会注入 preload 的绝对路径，
 * 早期写的 process.env.ELECTRON_VITE_PRELOAD 是凭空编的变量，永远是 undefined，
 * 那 preload 根本不会加载，window.fd 也就一直不存在。
 *
 * 主进程以 ESM 形式构建，__dirname 不可用，只能用 import.meta.url 反推。
 */
const here = dirname(fileURLToPath(import.meta.url))
const preloadPath = join(here, '../preload/index.cjs')

let win: BrowserWindow | null = null
let tray: Tray | null = null
let store: Store
let manager: Manager

function createWindow(): void {
  win = new BrowserWindow({
    width: 1240,
    height: 780,
    minWidth: 1080,
    minHeight: 620,
    title: 'FastDrop · 多线程下载管理器',
    autoHideMenuBar: true,
    backgroundColor: store.loadSettings().dark ? '#141414' : '#f5f5f5',
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      // 游戏页签用 <webview> 加载 gamer520/nekogal/playzip；默认关闭，只
      // 在需要时开。webview 在沙箱化 preload 下也能用，但要显式开开关。
      webviewTag: true,
    },
  })

  win.once('ready-to-show', () => win?.show())

  // 窗口内的外链交给系统浏览器，不要开新的 Electron 窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // ELECTRON_RENDERER_URL 是 electron-vite 开发模式唯一注入的真实变量；
  // 生产构建读已编译好的渲染产物，路径相对主进程文件位置计算。
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(join(here, '../renderer/index.html'))
  }
}

function createTray(): void {
  const icon = nativeImage.createEmpty()
  tray = new Tray(icon)
  tray.setToolTip('FastDrop · 多线程下载管理器')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示窗口', click: () => win?.show() },
      { type: 'separator' },
      { label: '退出', click: () => quit() },
    ]),
  )
  tray.on('click', () => win?.show())
}

function wireIpc(): void {
  const m = manager
  const s = store

  // 返回 rows（定义 + 实时快照）而不是裸 listDefs：渲染进程靠它恢复断点进度
  ipcMain.handle(Ipc.TasksList, () => m.rows())
  ipcMain.handle(Ipc.TasksAdd, (_e, input) => m.add(input))
  ipcMain.handle(Ipc.TasksRemove, (_e, id: string) => m.remove(id))
  ipcMain.handle(Ipc.TasksClearFinished, () => m.clearFinished())
  ipcMain.handle(Ipc.TaskAction, (_e, id: string, action: string) => m.action(id, action))
  ipcMain.handle(Ipc.TaskSetThreads, (_e, id: string, n: number) => m.setThreads(id, n))
  ipcMain.handle(Ipc.ActionAll, (_e, action: string) => m.actionAll(action))

  ipcMain.handle(Ipc.SettingsGet, () => s.loadSettings())
  ipcMain.handle(Ipc.SettingsSave, (_e, next) => {
    const before = s.loadSettings()
    s.saveSettings(next)
    m.settings = next
    if (next.dark !== before.dark) {
      win?.webContents.send(Ipc.ThemeChanged, next.dark ? 'dark' : 'light')
    }
    return next
  })

  ipcMain.handle(Ipc.PickDir, () => {
    const res = dialog.showOpenDialogSync(win!, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: s.loadSettings().download_dir || undefined,
    })
    return res?.[0] ?? null
  })

  ipcMain.handle(Ipc.OpenPath, (_e, p: string) => shell.openPath(p))

  // 打开任务文件所在文件夹。dest 指向目录时先把它当目录打开；文件存在时
  // showItemInFolder 会高亮显示它，比单纯打开父目录更符合"打开所在位置"的直觉。
  ipcMain.handle(Ipc.OpenFolder, (_e, id: string) => {
    const d = m.listDefs().find((x) => x.id === id)
    if (!d) return
    const p = d.dest
    if (existsSync(p)) shell.showItemInFolder(p)
    else if (existsSync(dirname(p))) shell.openPath(dirname(p))
    else shell.openPath(p)
  })
  ipcMain.handle(Ipc.ThemeGet, () => (s.loadSettings().dark ? 'dark' : 'light'))
  ipcMain.on(Ipc.WindowMinimize, () => win?.minimize())
  ipcMain.on(Ipc.WindowClose, () => win?.hide())
}

app.whenReady().then(() => {
  store = new Store()
  const initialSettings = store.loadSettings()
  const initialDefs = store.loadTasks()
  manager = new Manager(
    initialSettings,
    (push) => win?.webContents.send(Ipc.TaskProgress, push),
    (tasks) => store.saveTasks(tasks),
    initialDefs,
  )
  wireIpc()
  // 游戏站：IPC + 捕获桥。依赖 Manager.add、当前设置（下载目录/线程数）
  wireSites({
    getWindow: () => win,
    addTask: (input) => manager.add(input),
    getDownloadDir: () => store.loadSettings().download_dir,
    getThreads: () => store.loadSettings().threads,
  })
  createWindow()
  createTray()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 关窗只藏到托盘，不退出：window-all-closed 挂空回调，把 Electron 默认的
// 退出行为吃掉，保持进程和调度器活着。真正的退出走托盘菜单 → quit()。
function quit(): void {
  manager?.shutdown()
  app.quit()
}

app.on('window-all-closed', () => {
  // 故意什么都不做：等待托盘菜单退出
})
app.on('before-quit', () => {
  manager?.shutdown()
})
