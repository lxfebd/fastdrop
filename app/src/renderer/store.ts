/**
 * 渲染进程的全局状态。用 reactive 对象 + 手动管理，不引 pinia——
 * 状态不多（设置、任务列表、当前选中），引框架反而多一层抽象。
 *
 * 通过 window.fd（preload 暴露的桥）和主进程通信。轮询兜底：
 * 引擎事件推送之外，列表每 1s 主动拉一次，保证关掉再开不丢断点进度。
 */
import { reactive } from 'vue'
import type { FastDropApi } from '../shared/ipc'
import type { Settings, TaskDef, TaskRow, TaskSnapshot } from '../shared/types'

declare global {
  interface Window {
    fd: FastDropApi
  }
}

const REFRESH_MS = 1000

interface AppState {
  ready: boolean
  settings: Settings | null
  /** 持久化的任务定义，来自列表轮询 */
  defs: TaskDef[]
  /** 列表 UI 用的行数据：定义 + 实时快照（引擎未启动时为 null） */
  rows: TaskRow[]
  /** 事件推送维护的快照缓存，进度回调直接落到这里 */
  snapshots: Record<string, TaskSnapshot>
  /** 全速合计，和老版状态栏口径一致 */
  totalSpeed: number
  /** 侧栏过滤条件，对应老版 _filter */
  filter: string
  /** 当前选中的任务 id */
  selectedId: string | null
}

const state: AppState = reactive({
  ready: false,
  settings: null,
  defs: [],
  rows: [],
  snapshots: {},
  totalSpeed: 0,
  filter: 'all',
  selectedId: null,
})

async function refreshDefs(): Promise<void> {
  if (!window.fd) return
  try {
    state.rows = await window.fd.listTasks()
    state.defs = state.rows.map((r) => r.def)
    // 轮询回来的快照也进缓存，保证列表行不依赖推送时机的先后
    for (const r of state.rows) {
      if (r.snap) state.snapshots[r.id] = r.snap
    }
    state.totalSpeed = state.rows.reduce(
      (sum, r) => sum + (r.snap?.state === 'downloading' ? r.snap.speed : 0),
      0,
    )
  } catch {
    // 主进程未就绪时忽略，下次轮询重试
  }
}

async function init(): Promise<void> {
  if (!window.fd) {
    // 浏览器里直接打开 dev server 时没有桥，给个空壳不至于白屏
    state.ready = true
    return
  }
  state.settings = await window.fd.getSettings()
  await refreshDefs()
  state.ready = true

  window.fd.onTaskProgress((p) => {
    state.snapshots[p.taskId] = p.snapshot
    const row = state.rows.find((r) => r.id === p.taskId)
    if (row) row.snap = p.snapshot
  })

  window.fd.onThemeChanged((t) => {
    if (state.settings) state.settings.dark = t === 'dark'
  })

  setInterval(refreshDefs, REFRESH_MS)
}

export function useAppStore() {
  return {
    state,
    init,
    refreshDefs,
    select(id: string | null): void {
      state.selectedId = id
    },
    setFilter(filter: string): void {
      state.filter = filter
    },
  }
}
