/**
 * preload 脚本。渲染进程和主进程之间唯一的桥梁。
 *
 * 渲染进程开了 sandbox + contextIsolation，直接看不到 Node 和 electron 的
 * ipcRenderer。这里把需要的能力用白名单方式挑出来，通过 contextBridge 挂到
 * window.fd 上。别在这里暴露 ipcRenderer 本身——一旦暴露，渲染进程里的
 * 任意 JS（包括第三方依赖）就能往主进程发任意频道，等于绕过沙箱。
 */
import { contextBridge, ipcRenderer } from 'electron'
import { Ipc } from '../shared/ipc'
import type { FastDropApi } from '../shared/ipc'

/** 订阅推送事件，返回取消订阅函数。 */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: FastDropApi = {
  listTasks: () => ipcRenderer.invoke(Ipc.TasksList),
  addTask: (input) => ipcRenderer.invoke(Ipc.TasksAdd, input),
  removeTask: (id, deleteFiles) => ipcRenderer.invoke(Ipc.TasksRemove, id, deleteFiles === true),
  clearFinished: () => ipcRenderer.invoke(Ipc.TasksClearFinished),
  action: (id, action) => ipcRenderer.invoke(Ipc.TaskAction, id, action),
  setThreads: (id, n) => ipcRenderer.invoke(Ipc.TaskSetThreads, id, n),
  setChecksum: (id, checksum) => ipcRenderer.invoke(Ipc.TaskSetChecksum, id, checksum),
  actionAll: (action) => ipcRenderer.invoke(Ipc.ActionAll, action),
  getSettings: () => ipcRenderer.invoke(Ipc.SettingsGet),
  saveSettings: (s) => ipcRenderer.invoke(Ipc.SettingsSave, s),
  pickDir: () => ipcRenderer.invoke(Ipc.PickDir),
  openPath: (p) => ipcRenderer.invoke(Ipc.OpenPath, p),
  openFolder: (id) => ipcRenderer.invoke(Ipc.OpenFolder, id),
  openFile: (id) => ipcRenderer.invoke(Ipc.OpenFile, id),
  getTheme: () => ipcRenderer.invoke(Ipc.ThemeGet),
  // 首屏自救：挂载完成报 ready，主进程的加载看门狗就此收工；启动期抛错时把
  // 真正的错因发过去，兜底页才写得出一句有用的话。都是 send，不等回音。
  uiBoot: {
    ready: () => {
      void ipcRenderer.send(Ipc.UiReady)
    },
    error: (detail) => {
      void ipcRenderer.send(Ipc.UiBootError, String(detail).slice(0, 600))
    },
  },
  // send 是 fire-and-forget，没有返回值。包一层 Promise 来满足 API 形状：
  // 窗口操作没有可等待的结果，调用方照常 await 即可。
  minimize: () => {
    void ipcRenderer.send(Ipc.WindowMinimize)
    return Promise.resolve()
  },
  close: () => {
    void ipcRenderer.send(Ipc.WindowClose)
    return Promise.resolve()
  },
  onTaskProgress: (cb) => subscribe(Ipc.TaskProgress, cb),
  onThemeChanged: (cb) => subscribe(Ipc.ThemeChanged, cb),
  onTaskFocus: (cb) => subscribe(Ipc.TaskFocus, cb),

  // 游戏站：invoke 走主进程，推送走 subscribe
  sitesList: () => ipcRenderer.invoke(Ipc.SitesList),
  sitesSearch: (siteId, keyword) => ipcRenderer.invoke(Ipc.SitesSearch, siteId, keyword),
  sitesMirrors: (siteId, detailUrl) => ipcRenderer.invoke(Ipc.SitesMirrors, siteId, detailUrl),
  sitesResolve: (mirror) => ipcRenderer.invoke(Ipc.SitesResolve, mirror),
  sitesAddTask: (input) => ipcRenderer.invoke(Ipc.SitesAddTask, input),
  webviewOpenExternal: (url) => ipcRenderer.invoke(Ipc.WebviewOpenExternal, url),
  onSiteDownload: (cb) => subscribe(Ipc.SiteDownload, cb),

  // 应用更新：invoke 走主进程，状态机推送走 subscribe
  checkUpdate: () => ipcRenderer.invoke(Ipc.UpdateCheck),
  installUpdate: () => ipcRenderer.invoke(Ipc.UpdateInstall),
  updateStatus: () => ipcRenderer.invoke(Ipc.UpdateStatusGet),
  onUpdateStatus: (cb) => subscribe(Ipc.UpdateStatus, cb),
}

contextBridge.exposeInMainWorld('fd', api)
