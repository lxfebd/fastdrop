/**
 * 渲染进程的全局状态。用 reactive 对象 + 手动管理，不引 pinia——
 * 状态不多（设置、任务列表、当前选中），引框架反而多一层抽象。
 *
 * 通过 window.fd（preload 暴露的桥）和主进程通信。轮询兜底：
 * 引擎事件推送之外，列表每 1s 主动拉一次，保证关掉再开不丢断点进度。
 */
import { reactive } from 'vue'
import type { FastDropApi } from '../shared/ipc'
import type { Settings, TaskDef, TaskRow } from '../shared/types'

declare global {
  interface Window {
    fd: FastDropApi
  }
}

// 兜底轮询周期。引擎本来每 100ms 主动推一次进度（onTaskProgress 里直接
// 合并进快照），所以这个轮询只是防丢失用的保险，不是 UI 的更新来源。
// 1s 一次是浪费：每次都是全量 IPC 重拉 + state.rows 整体替换（新对象走
// v-for key 重建整行）+ filteredRows/counts 全部失效重算，还会和推送打架
// 让进度条跳。5s 足够发现「推送链路断了」，代价降到五分之一。
const REFRESH_MS = 5000

interface AppState {
  ready: boolean
  settings: Settings | null
  /** 持久化的任务定义，来自列表轮询 */
  defs: TaskDef[]
  /** 列表 UI 用的行数据：定义 + 实时快照（引擎未启动时为 null） */
  rows: TaskRow[]
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
  totalSpeed: 0,
  filter: 'all',
  selectedId: null,
})

async function refreshDefs(): Promise<void> {
  if (!window.fd) return
  try {
    state.rows = await window.fd.listTasks()
    state.defs = state.rows.map((r) => r.def)
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
