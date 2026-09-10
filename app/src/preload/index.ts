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
  removeTask: (id) => ipcRenderer.invoke(Ipc.TasksRemove, id),
  clearFinished: () => ipcRenderer.invoke(Ipc.TasksClearFinished),
  action: (id, action) => ipcRenderer.invoke(Ipc.TaskAction, id, action),
  setThreads: (id, n) => ipcRenderer.invoke(Ipc.TaskSetThreads, id, n),
  actionAll: (action) => ipcRenderer.invoke(Ipc.ActionAll, action),
  getSettings: () => ipcRenderer.invoke(Ipc.SettingsGet),
  saveSettings: (s) => ipcRenderer.invoke(Ipc.SettingsSave, s),
  pickDir: () => ipcRenderer.invoke(Ipc.PickDir),
  openPath: (p) => ipcRenderer.invoke(Ipc.OpenPath, p),
  openFolder: (id) => ipcRenderer.invoke(Ipc.OpenFolder, id),
  getTheme: () => ipcRenderer.invoke(Ipc.ThemeGet),
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
}

contextBridge.exposeInMainWorld('fd', api)
