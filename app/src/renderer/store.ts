/**
 * 渲染进程的全局状态。用 reactive 对象 + 手动管理，不引 pinia——
 * 状态不多（设置、任务列表、当前选中），引框架反而多一层抽象。
 *
 * 通过 window.fd（preload 暴露的桥）和主进程通信。轮询兜底：
 * 引擎事件推送之外，列表每隔几秒主动拉一次，保证关掉再开不丢断点进度。
 */
import { reactive } from 'vue'
import { message } from 'ant-design-vue'
import type { FastDropApi, SiteDownloadPush } from '../shared/ipc'
import type { ActionResult, AddResult, Settings, TaskDef, TaskRow } from '../shared/types'
import type { TaskSort } from './status'

declare global {
  interface Window {
    fd: FastDropApi
  }
}

/**
 * 兜底轮询周期。引擎本来每 100ms 主动推一次进度（onTaskProgress 里直接
 * 合并进快照），所以这个轮询只是防丢失用的保险，不是 UI 的更新来源。
 * 太密是浪费：每次都是全量 IPC 重拉 + state.rows 整体替换（新对象走
 * v-for key 重建整行）+ filteredRows/counts 全部失效重算，还会和推送打架
 * 让进度条跳。5s 足够发现「推送链路断了」。
 */
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
  /** 工具栏关键词搜索（与状态过滤叠加） */
  query: string
  /** 列表排序方式 */
  sort: TaskSort
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
  query: '',
  sort: 'added-desc',
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

  /**
   * 进度推送遇到列表里没有的 id = 有一条任务是从渲染层之外冒出来的（浏览器捕获、
   * 托盘、通知、外部 IPC）。这些路径不会经过新建弹窗的乐观插入，只能等 5s 兜底
   * 轮询——于是提示写着「已添加到下载列表」，列表里却什么都没有，用户认为软件在骗人。
   * 第一条推送到达时顺手重拉一次定义，新行当场出现；加锁是因为推送每 100ms 一条。
   */
  let refetching = false
  let lastRefetch = 0
  window.fd.onTaskProgress((p) => {
    const row = state.rows.find((r) => r.id === p.taskId)
    if (row) {
      row.snap = p.snapshot
      return
    }
    // 已经删掉的任务若还在推，不能每 100ms 重拉一次全量定义：冷却 1s。
    if (refetching || Date.now() - lastRefetch < 1000) return
    refetching = true
    lastRefetch = Date.now()
    void refreshDefs().finally(() => {
      refetching = false
    })
  })

  window.fd.onThemeChanged((t) => {
    if (state.settings) state.settings.dark = t === 'dark'
  })

  // 点了系统通知 → 把那条任务摆到眼前。必须顺手清掉搜索词并回到「全部」桶：
  // 失败任务很可能正被当前的过滤条件挡着，只 select 的话列表里看不到任何变化，
  // 用户会认为通知是假的。
  window.fd.onTaskFocus((id) => {
    state.query = ''
    state.filter = 'all'
    state.selectedId = id
  })

  // 游戏站下载的推送挂在这里而不是 GameSites 组件里：浏览器下载的「完成」
  // 提示可能在用户切回下载页签之后才到，挂在组件上就等于把这条消息丢掉。
  window.fd.onSiteDownload(handleSiteDownload)

  setInterval(refreshDefs, REFRESH_MS)
}

/**
 * 写操作的统一回执。主进程现在一律返回 {ok} 而不是 undefined，
 * 失败必须让用户看见——以前 handler 抛错时界面照样提示成功。
 */
export function report(result: ActionResult | AddResult, okText?: string): boolean {
  if (!result.ok) {
    message.error(result.error)
    return false
  }
  if (okText) {
    if ('duplicate' in result && result.duplicate) message.info('该链接已经在下载列表里')
    else message.success(okText)
  }
  return true
}

/** IPC 通道本身被拒（主进程崩溃、频道未注册）也要有声音。 */
export function reportRejection(e: unknown): void {
  message.error(`操作失败：${e instanceof Error ? e.message : String(e)}`)
}

async function handleSiteDownload(p: SiteDownloadPush): Promise<void> {
  if (p.kind === 'browser') {
    // 会话链接交回浏览器下载，不是失败：告诉用户文件正在往哪走
    message.info(`${p.filename} 需要浏览器会话，已用浏览器下载到 ${p.dest}`)
    return
  }
  if (p.kind === 'done') {
    if (p.ok) message.success(`${p.filename} 下载完成`)
    else message.error(`${p.filename}：${p.error ?? '浏览器下载失败'}`)
    return
  }
  // 公开直链：建 FastDrop 任务，进度在下载列表里看
  try {
    const r = await window.fd.sitesAddTask({ url: p.url, filename: p.filename })
    report(r, `已添加到下载列表：${p.filename ?? ''}`)
  } catch (e) {
    reportRejection(e)
  }
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
    setQuery(query: string): void {
      state.query = query
    },
    setSort(sort: TaskSort): void {
      state.sort = sort
    },
  }
}
