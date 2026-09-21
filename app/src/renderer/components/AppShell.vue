<script setup lang="ts">
/**
 * 主界面骨架：
 *   侧栏 | 工具栏 + 任务表 / 详情卡 | 状态栏
 *
 * 这里只做布局和动作分发，展示逻辑都在子组件里。Web 没有内建的拖拽分栏，
 * 列表和详情之间用固定宽度 + 卡片边界替代——拖拽调整不是下载工具的核心功能，
 * 不值得为了它引一个依赖。
 *
 * 视觉层级（改样式前先读 theme.ts 的层级约定）：灰画布 → 白面板 → 行内表面。
 * 三个大区域（工具栏、任务表、详情）是独立白卡浮在灰底上，靠边界产生层级，
 * 而不是用 1px 线硬切。整窗同一色会让界面塌成一整块平面，那是初版的主要问题。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  CaretRightFilled,
  DownOutlined,
  InfoCircleOutlined,
  PlusOutlined,
  SearchOutlined,
} from '@ant-design/icons-vue'
import { Button, Checkbox, Dropdown, Empty, Input, Menu, MenuItem, message, Modal, Select } from 'ant-design-vue'
import type { Settings, TaskRow } from '../../shared/types'
import { DEFAULT_SETTINGS, isAutoResumable } from '../../shared/types'
import type { UpdateStatus } from '../../shared/types'
import { IDLE_UPDATE_STATUS } from '../../shared/types'
import { fmtSize, fmtSpeed } from '../../shared/format'
import {
  matchesFilter,
  matchesQuery,
  percentText,
  progressRatio,
  rowName,
  rowState,
  sortRows,
  SORT_OPTIONS,
  type TaskSort,
} from '../status'
import Sidebar from './Sidebar.vue'
// 类型也叫 TaskRow，组件起个别名避免同名冲突
import TaskRowCard from './TaskRow.vue'
import DetailPanel from './DetailPanel.vue'
import NewDownloadDialog from './NewDownloadDialog.vue'
import SettingsDialog from './SettingsDialog.vue'
import ClockLabel from './ClockLabel.vue'
import GameSites from './GameSites.vue'
import { useAppStore, report, reportRejection } from '../store'

const store = useAppStore()
const { state } = store

// 版本号由构建期注入（见 electron.vite.config.ts 的 define），模板里读这个
// 本地绑定——直接在模板写 __APP_VERSION__ 会被编译成 _ctx.__APP_VERSION__，拿不到值。
const version = __APP_VERSION__

// --------------------------------------------------------------- 应用更新

/** 更新状态机：主进程推送 + 启动时查询初值，双保险。 */
const update = ref<UpdateStatus>({ ...IDLE_UPDATE_STATUS })
let offUpdate: (() => void) | null = null

/** 按钮文案：不一样的状态给不一样的说法，避免「点击下载」「正在下载」混成一句话。 */
const updateLabel = computed(() => {
  switch (update.value.phase) {
    case 'checking':
      return { text: '检查更新中…', disabled: true }
    case 'downloading':
      return { text: `下载更新 ${Math.round((update.value.progress ?? 0) * 100)}%`, disabled: true }
    case 'downloaded':
      return { text: '重启并安装更新', disabled: false }
    case 'available':
      return { text: '发现新版本，正在准备…', disabled: true }
    default:
      return { text: '检查更新', disabled: false }
  }
})

/** 更新状态是否值得占一条横条：检查/下载/已就绪才显示，idle 不占版面。 */
const showUpdateBar = computed(
  () => update.value.phase !== 'idle' && update.value.phase !== 'installing',
)

const updateBarText = computed(() => {
  const u = update.value
  if (u.phase === 'checking') return '正在检查应用更新…'
  if (u.phase === 'downloading') {
    const t = u.transferred ?? 0
    const total = u.total ?? 0
    return total > 0 ? `正在下载 v${u.version ?? ''} 更新 ${fmtSize(t)} / ${fmtSize(total)}` : `正在下载 v${u.version ?? ''} 更新…`
  }
  if (u.phase === 'downloaded') return `新版 v${u.version ?? ''} 已下载完成`
  if (u.phase === 'installing') return '正在安装更新…'
  return ''
})

/** 手动触发「立即检查」。开发版主进程会拒绝并回报「当前已是最新」，照实显示。 */
async function checkUpdate(): Promise<void> {
  try {
    const r = await window.fd.checkUpdate()
    if (!r.ok) message.info(r.error)
  } catch (e) {
    reportRejection(e)
  }
}

/** 「重启并安装」：点了之后主进程立刻重启应用，没有回头路，先弹确认。 */
async function installUpdate(): Promise<void> {
  if (update.value.phase !== 'downloaded') return
  message.info('正在重启以完成更新…')
  try {
    const r = await window.fd.installUpdate()
    if (!r.ok) message.error(r.error)
  } catch (e) {
    reportRejection(e)
  }
}

function onUpdateStatus(s: UpdateStatus): void {
  update.value = s
}

// --------------------------------------------------------------- 派生数据

/**
 * 当前可见的行：状态桶 → 关键词 → 排序，三层都过一遍。
 * 搜索和过滤是「与」关系（先筛桶再筛词），规则都在 status.ts，模板里不重复。
 */
const filteredRows = computed<TaskRow[]>(() =>
  sortRows(
    state.rows.filter((r) => matchesFilter(r.snap?.state, state.filter) && matchesQuery(r, state.query)),
    state.sort,
  ),
)

/** 有任务但被桶/关键词挡住了：空态要给出「清掉筛选」的出口，而不是让人自己猜。 */
const isFiltered = computed(() => state.filter !== 'all' || state.query.trim() !== '')

/** 空态文案。搜索没命中时把词回显出来，用户才知道是自己筛掉了而不是任务丢了。 */
const emptyText = computed(() => {
  const q = state.query.trim()
  if (q) return `没有匹配「${q}」的任务`
  if (state.filter !== 'all') return '该分类下没有任务'
  return '还没有下载任务'
})

/** 排序选项直接复用 status.ts 的定义，选择框和 sortRows() 永远同一套键。 */
const sortOptions = SORT_OPTIONS

function onSortChange(v: unknown): void {
  store.setSort((v as TaskSort) ?? 'added-desc')
}

/** 侧栏/状态栏共用各状态计数。all 是全部任务数。 */
const counts = computed(() => {
  const all = state.rows.length
  return {
    all,
    downloading: state.rows.filter((r) => r.snap?.state === 'downloading').length,
    paused: state.rows.filter((r) => r.snap?.state === 'paused').length,
    done: state.rows.filter((r) => r.snap?.state === 'done').length,
    error: state.rows.filter((r) => r.snap?.state === 'error').length,
  }
})

/** 计数在筛选状态下写成「可见 / 全部」，否则用户会以为任务少了一半。 */
const countText = computed(() => {
  const total = counts.value.all
  if (!isFiltered.value) return `${total} 个任务`
  return `${filteredRows.value.length} / ${total} 个任务`
})

/** 全部任务合计速度。没在跑时显示「空闲」，和老版一致。 */
const speedText = computed(() => (state.totalSpeed > 0 ? fmtSpeed(state.totalSpeed) : '空闲'))

const selectedRow = computed<TaskRow | null>(() =>
  state.rows.find((r) => r.id === state.selectedId) ?? null,
)

/**
 * 选中项必须落在当前可见行里，否则右侧详情卡会显示「还没有下载任务」——
 * 明明列表有三行，用户只会认为软件读不到任务。切过滤桶、删掉选中行、
 * 首次加载都走这一条规则：自动落到第一行。
 */
watch(
  filteredRows,
  (rows) => {
    if (rows.some((r) => r.id === state.selectedId)) return
    store.select(rows[0]?.id ?? null)
  },
  { immediate: true },
)

/**
 * 批量按钮只在有可操作对象时可用，否则空点一次白拉一趟 IPC。
 * 「全部开始」只做两件事：唤醒 paused、补上排队槽位（见 Manager.startAll），
 * 所以按钮的可用条件必须和它一致——把 error/cancelled 算进来会变成
 * 「按钮亮着但点了没反应」。失败任务要重试请走行上的「重新下载」。
 */
const hasRunning = computed(() => counts.value.downloading > 0)
const hasRunnable = computed(() =>
  state.rows.some((r) => {
    const st = r.snap?.state ?? r.def.state
    return st === 'paused' || isAutoResumable(st)
  }),
)
/** 「重试全部失败」的可用性：走的是断点续传（start），不是清零重下。 */
const hasFailed = computed(() => counts.value.error > 0)

/** 状态栏左侧：正在跑的优先，其次暂停、失败。 */
const statusLeft = computed(() => {
  const c = counts.value
  if (c.downloading) return `下载中 ${c.downloading} 个任务`
  if (c.paused) return `已暂停 ${c.paused} 个任务`
  if (c.error) return `${c.error} 个任务失败`
  return '就绪'
})

/**
 * 状态栏中间：选中任务的文件名 + 进度。
 * 未知长度时给破折号而不是 0.0%——那会让一个正在下的 8 GB 文件看起来毫无进展。
 */
const statusMid = computed(() => {
  const row = selectedRow.value
  if (!row || !row.snap) return ''
  const i = Math.max(row.def.dest.lastIndexOf('\\'), row.def.dest.lastIndexOf('/'))
  const name = (i >= 0 ? row.def.dest.slice(i + 1) : row.def.dest) || row.def.url
  return `${name} · ${percentText(progressRatio(row.snap, row.def))}`
})

// --------------------------------------------------------------- 对话框

const showNew = ref(false)
const showSettings = ref(false)
const showAbout = ref(false)

/**
 * 游戏站视图挂载过一次就留着（详见模板里 v-if + v-show 那段注释）。
 * immediate 是不把正确性押在「切到 games 一定发生在本组件挂载之后」这条时序上：
 * 真出现那种情形时，用户看到的是这一整页空白，而不是少个动画。
 */
const gamesMounted = ref(false)
watch(
  () => state.filter,
  (f) => {
    if (f === 'games') gamesMounted.value = true
  },
  { immediate: true },
)

/** 保存设置面板里未提交的表单，SettingsDialog 内部也是从 settings 拷贝的。
 *  从 DEFAULT_SETTINGS 拷而不是手写一份字面量：手写的那份每加一个字段就漏一个，
 *  漏掉的字段主进程会回落到默认值，用户在界面上看到的是「改了没存」。 */
const settingsForm = reactive<Settings>({ ...DEFAULT_SETTINGS })

function openSettings(): void {
  if (state.settings) Object.assign(settingsForm, state.settings)
  showSettings.value = true
}

async function saveSettings(s: Settings): Promise<void> {
  try {
    // 采用主进程实际落盘的那份：非法值（线程数填 999）会被钳掉，
    // 拿自己手上的对象覆盖 state 会让 UI 显示和磁盘不一致。
    const res = await window.fd.saveSettings(s)
    if (!res.ok) {
      // 不关弹窗：失败的多半就是用户刚填的那一项（代理地址写错），
      // 关掉再让他从头找一遍是折磨人。
      message.error(res.error)
      return
    }
    Object.assign(state.settings!, res.settings)
    Object.assign(settingsForm, res.settings)
    showSettings.value = false
    message.success('设置已保存')
  } catch (e) {
    reportRejection(e)
  }
}

// --------------------------------------------------------------- 新建

/**
 * 老版在对话框里就补了协议前缀，用户贴裸域名也能用。
 * 放到这里而不是组件内，是因为规范化属于业务规则，不该由输入框决定。
 */
function normalizeUrl(url: string): string {
  const u = url.trim()
  return /^https?:\/\//i.test(u) || /^ftp:\/\//i.test(u) ? u : `https://${u}`
}

async function onCreate(input: {
  url: string
  dest: string
  threads: number
  note?: string
  checksum?: string
}): Promise<void> {
  showNew.value = false
  try {
    const r = await window.fd.addTask({
      url: normalizeUrl(input.url),
      dest: input.dest.trim(),
      threads: input.threads,
      note: input.note ?? '',
      // 对话框里已经用 normalizeChecksum 判过一次，空串就是「不校验」。
      checksum: input.checksum ?? '',
    })
    // 失败要看得见：以前这里 catch 掉一切，用户点了「确定」什么也不会发生
    if (!report(r, '任务已添加')) return
    store.setFilter('all')
    await store.refreshDefs()
  } catch (e) {
    reportRejection(e)
  }
}

async function clearFinished(): Promise<void> {
  try {
    report(await window.fd.clearFinished())
  } catch (e) {
    reportRejection(e)
  }
  store.select(null)
  await store.refreshDefs()
}

// --------------------------------------------------------------- 删除

/**
 * 移除确认框。以前是一句「磁盘上已下载的文件不会删除」的纯文本弹窗，
 * 想连文件一起删的人只能移除完再去文件夹里手动找——所以这里把选项摆进
 * 对话框：默认不删文件（保守），勾了才删成品 + 断点。
 *
 * 用受控 Modal 而不是 Modal.confirm：后者要挂 h(Checkbox) 才能带复选框，
 * 而勾选状态本身需要一处响应式来源，写在模板里比写在渲染函数里好读。
 */
const removeTarget = ref<string | null>(null)
const deleteFiles = ref(false)

function askRemove(id: string): void {
  if (!state.settings?.confirm_delete) {
    void doRemove(id, false)
    return
  }
  deleteFiles.value = false
  removeTarget.value = id
}

async function doRemove(id: string, withFiles: boolean): Promise<void> {
  if (state.selectedId === id) store.select(null)
  removeTarget.value = null
  try {
    report(await window.fd.removeTask(id, withFiles))
  } catch (e) {
    reportRejection(e)
  }
  await store.refreshDefs()
}

async function confirmRemoveModal(): Promise<void> {
  if (removeTarget.value) await doRemove(removeTarget.value, deleteFiles.value)
}

/** 正在移除的那一行，用来在对话框里点名是哪个文件。 */
const removeRow = computed<TaskRow | null>(
  () => state.rows.find((r) => r.id === removeTarget.value) ?? null,
)

const removeName = computed(() => (removeRow.value ? rowName(removeRow.value) : ''))
/** 说明「删文件」到底删什么、多大，以及删了会有什么后果：成品和断点分开讲。 */
const removeFileInfo = computed(() => {
  const r = removeRow.value
  if (!r) return { desc: '', warn: '' }
  const got = r.snap?.downloaded ?? r.def.downloaded ?? 0
  const total = r.snap?.total || r.def.total || 0
  if (rowState(r) === 'done') {
    return { desc: `成品文件 ${fmtSize(total || got)}`, warn: '成品删掉后无法恢复。' }
  }
  if (got > 0) {
    return { desc: `未完成的断点 ${fmtSize(got)}（.part）`, warn: '断点删掉之后无法续传，只能从头重下。' }
  }
  return { desc: '还没有落盘的文件', warn: '勾不勾都一样。' }
})

async function doAction(id: string, action: string): Promise<void> {
  try {
    switch (action) {
      case 'start':
      case 'pause':
      case 'resume':
        report(await window.fd.action(id, action))
        break
      case 'retry':
        report(await window.fd.action(id, 'retry'), '已重新开始下载')
        break
      case 'open':
        // 打开结果必须回报：以前 await 完什么都不说，资源管理器没弹出来时
        // 用户只会以为「按钮坏了」。
        report(await window.fd.openFolder(id))
        break
      case 'open-file':
        report(await window.fd.openFile(id))
        break
      case 'remove':
        askRemove(id)
        break
      default:
        break
    }
  } catch (e) {
    reportRejection(e)
  }
  await store.refreshDefs()
}

/** 批量动作：一次 IPC 打全表，按钮/菜单项的键和主进程 ALL_ACTIONS 对齐。 */
const BATCH_KEYS = {
  'start-all': 'start',
  'pause-all': 'pause',
  'retry-failed': 'retry-failed',
} as const

async function doNav(key: string): Promise<void> {
  switch (key) {
    case 'add':
      showNew.value = true
      break
    case 'settings':
      openSettings()
      break
    case 'about':
      showAbout.value = true
      break
    case 'games':
      // 游戏站是视图而非过滤器：切到该视图，不改 filter 桶
      store.setFilter('games')
      break
    case 'clear-finished':
      await clearFinished()
      break
    case 'start-all':
    case 'pause-all':
    case 'retry-failed': {
      const text = key === 'retry-failed' ? '已重新排队全部失败任务' : undefined
      try {
        report(await window.fd.actionAll(BATCH_KEYS[key]), text)
      } catch (e) {
        reportRejection(e)
      }
      await store.refreshDefs()
      break
    }
    default:
      store.setFilter(key)
  }
}

function delSelected(): void {
  if (state.selectedId) void doAction(state.selectedId, 'remove')
}

/** 清空搜索与状态桶，回到「全部」。空态里的「显示全部」走这一条。 */
function clearFilters(): void {
  store.setFilter('all')
  store.setQuery('')
}

// --------------------------------------------------------------- 快捷键

/** 输入框聚焦时不拦截，否则打字会被全局快捷键截走。 */
function isEditable(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null
  if (!t || !t.tagName) return false
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable
}

/**
 * 聚焦搜索框。这里用 DOM 查询而不是模板 ref：ant-design-vue 的 Input 实例
 * 类型上没有稳定的 focus() 声明，为了一个焦点动作把类型写成 any 不值当。
 */
function focusSearch(): void {
  const el = document.getElementById('fd-search')
  const input = el instanceof HTMLInputElement ? el : el?.querySelector('input')
  input?.focus()
  input?.select()
}

function onKeydown(e: KeyboardEvent): void {
  const mod = e.ctrlKey || e.metaKey
  // Ctrl+F 和输入框无关，必须先判：光标正停在搜索框里时按 Ctrl+F 也要能清掉重打
  if (mod && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault()
    focusSearch()
    return
  }
  if (e.key === 'Escape' && state.query) {
    store.setQuery('')
    return
  }
  if (isEditable(e.target)) return
  if (mod && (e.key === 'n' || e.key === 'N')) {
    e.preventDefault()
    doNav('add')
  } else if (e.key === 'Delete') {
    e.preventDefault()
    delSelected()
  } else if (mod && (e.key === 'p' || e.key === 'P')) {
    e.preventDefault()
    doNav('pause-all')
  } else if (mod && (e.key === 'r' || e.key === 'R')) {
    e.preventDefault()
    doNav('start-all')
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  // 更新状态：先订阅再查询初值，避免查询结果把订阅期间到达的推送覆盖掉。
  offUpdate = window.fd.onUpdateStatus(onUpdateStatus)
  void window.fd.updateStatus().then(onUpdateStatus).catch(() => {})
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  offUpdate?.()
})
</script>

<template>
  <div class="shell">
    <!-- 更新状态条：检查/下载/已就绪时占一行，idle 整个消失不打扰 -->
    <div v-if="showUpdateBar" class="updatebar">
      <span class="ub-text">{{ updateBarText }}</span>
      <Button
        v-if="update.phase === 'downloaded'"
        type="primary"
        size="small"
        @click="installUpdate"
      >
        重启并安装
      </Button>
    </div>

    <div class="body">
      <Sidebar :rows="state.rows" :filter="state.filter" @nav="doNav" />

      <main class="right">
        <!-- 游戏站视图：占满右侧，不显示任务列表。
             两个指令各管一件事，缺一不可：
             - v-if 是「第一次进来才挂载」：webview 的 src 一挂载就会真去加载站点首页，
               无条件挂载等于每次启动应用都在后台加载三个站点的页面；
             - v-show 是「之后只藏不销毁」：切回下载列表再切回来，搜索结果、
               内嵌浏览器已经打开的页面和站点登录会话都得还在。以前这里只有 v-if，
               组件被销毁重建，用户看到的就是「一切页签什么都白重来」。 -->
        <GameSites v-if="gamesMounted" v-show="state.filter === 'games'" />

        <template v-if="state.filter !== 'games'">
          <!-- 工具栏：左标题计数 + 搜索排序，右速度 + 新建 + 批量菜单。
               四个批量按钮平铺时 1080px 窗口放不下（名称列会被挤成省略号），
               收进「批量操作」下拉后右侧只剩两个按钮，宽度终于稳定。 -->
        <div class="toolbar">
          <div class="tb-left">
            <span class="title">下载管理</span>
            <span class="tb-sep" />
            <span class="count">{{ countText }}</span>
            <span id="fd-search" class="tb-search">
              <Input
                v-model:value="state.query"
                size="small"
                placeholder="搜索名称或链接 (Ctrl+F)"
                allow-clear
              >
                <template #prefix><SearchOutlined /></template>
              </Input>
            </span>
            <Select
              :value="state.sort"
              size="small"
              :options="sortOptions"
              class="tb-sort"
              @change="onSortChange"
            />
          </div>
          <div class="tb-right">
            <span class="speed" :class="{ idle: state.totalSpeed <= 0 }">{{ speedText }}</span>
            <div class="tb-actions">
              <Button type="primary" size="small" class="btn-new" @click="doNav('add')">
                <template #icon><PlusOutlined /></template>
                新建下载
              </Button>
              <Dropdown :trigger="['click']">
                <Button type="text" size="small">
                  批量操作
                  <template #icon><DownOutlined /></template>
                </Button>
                <template #overlay>
                  <Menu>
                    <MenuItem :disabled="!hasRunnable" @click="doNav('start-all')">
                      <CaretRightFilled /> 全部开始
                    </MenuItem>
                    <MenuItem :disabled="!hasRunning" @click="doNav('pause-all')">
                      全部暂停
                    </MenuItem>
                    <MenuItem :disabled="!hasFailed" @click="doNav('retry-failed')">
                      重试全部失败（从断点续传）
                    </MenuItem>
                    <MenuItem :disabled="!counts.done" @click="clearFinished()">
                      清空已完成
                    </MenuItem>
                  </Menu>
                </template>
              </Dropdown>
            </div>
          </div>
        </div>

        <div class="split">
          <section class="panel list-panel">
            <!-- 表头与行共用 .split 上的 --col-* 变量，宽度只有一处定义 -->
            <div class="th">
              <span class="c-ic" />
              <span class="c-name">名称</span>
              <span class="c-prog">进度</span>
              <span class="c-tag">状态</span>
              <span class="c-act" />
            </div>
            <div class="list">
              <template v-if="filteredRows.length">
                <TaskRowCard
                  v-for="r in filteredRows"
                  :key="r.id"
                  :def="r.def"
                  :snap="r.snap"
                  :selected="r.id === state.selectedId"
                  @select="store.select(r.id)"
                  @action="(a: string) => doAction(r.id, a)"
                />
              </template>
              <!-- 三种空态必须分开：「列表本来就是空的」和「搜索没命中」
                   需要的下一步动作完全不同。 -->
              <div v-else class="empty-wrap">
                <Empty :description="emptyText">
                  <Button v-if="isFiltered" size="small" @click="clearFilters">
                    显示全部任务
                  </Button>
                  <Button v-else type="primary" size="small" @click="doNav('add')">
                    新建下载
                  </Button>
                </Empty>
              </div>
            </div>
          </section>

          <section class="panel detail-panel">
            <DetailPanel
              :def="selectedRow?.def ?? null"
              :snap="selectedRow?.snap ?? null"
              :has-tasks="state.rows.length > 0"
              @add="doNav('add')"
              @action="(a: string) => selectedRow && doAction(selectedRow.id, a)"
            />
          </section>
        </div>
        </template>
      </main>
    </div>

    <footer class="statusbar">
      <span class="left">
        <span class="dot" :class="{ on: counts.downloading > 0 }" />
        {{ statusLeft }}
      </span>
      <span v-if="statusMid" class="mid">{{ statusMid }}</span>
      <span class="spacer" />
      <span class="right-"><ClockLabel /></span>
    </footer>

    <!-- 两个对话框都自带标题栏，所以外层 Modal 不再传 title，避免出现两行标题 -->
    <Modal
      v-model:open="showNew"
      :footer="null"
      :width="520"
      destroy-on-close
      @cancel="showNew = false"
    >
      <NewDownloadDialog v-if="state.settings" :settings="state.settings" @submit="onCreate" />
    </Modal>

    <Modal
      v-model:open="showSettings"
      :footer="null"
      :width="560"
      destroy-on-close
      @cancel="showSettings = false"
    >
      <SettingsDialog :settings="settingsForm" @save="saveSettings" />
    </Modal>

    <!-- 移除确认：把「要不要连文件一起删」变成可见的勾选，默认不删 -->
    <Modal
      :open="!!removeTarget"
      title="移除任务"
      ok-text="移除"
      cancel-text="取消"
      :width="440"
      :ok-button-props="{ danger: true }"
      @ok="confirmRemoveModal"
      @cancel="removeTarget = null"
    >
      <div class="rm">
        <div class="rm-name">{{ removeName }}</div>
        <div class="rm-hint">默认只移除列表里的记录，磁盘上的文件保持不动。</div>
        <Checkbox v-model:checked="deleteFiles">同时删除磁盘上的文件</Checkbox>
        <div v-if="deleteFiles" class="rm-warn">
          将删除 {{ removeFileInfo.desc }}。{{ removeFileInfo.warn }}
        </div>
      </div>
    </Modal>

    <Modal v-model:open="showAbout" :footer="null" :width="420" @cancel="showAbout = false">
      <div class="about">
        <div class="about-head">
          <span class="about-logo"><DownOutlined /></span>
          <div>
            <div class="about-name">FastDrop</div>
            <div class="about-ver">v{{ version }} · 游戏下载盒子</div>
          </div>
        </div>
        <div class="about-desc">
          HTTP 分段并发下载，支持暂停恢复、断点续传、失败重试。
          任务配置保存在本机 <code>~/.fastdrop</code>，重启后断点不丢失。
        </div>
        <div class="about-foot">
          <InfoCircleOutlined /> Rust 引擎 · Vue 界面 · Electron 外壳
        </div>
        <div class="about-update">
          <Button size="small" :disabled="updateLabel.disabled" @click="checkUpdate">
            {{ updateLabel.text }}
          </Button>
          <span v-if="updateBarText" class="about-update-text">{{ updateBarText }}</span>
          <span v-if="update.error" class="about-update-err">{{ update.error }}</span>
        </div>
      </div>
    </Modal>
  </div>
</template>

<style scoped>
/* 画布层：灰底。白面板浮在上面，层级靠边界而不是线条 */
.shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--ant-color-bg-layout);
  overflow: hidden;
}
/* 更新状态条：浮在内容上方的小横条，下载/已就绪时通知用户，不需要时整条消失 */
.updatebar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 16px;
  background: var(--ant-color-primary-bg);
  border-bottom: 1px solid var(--ant-color-primary-border);
  font-size: 12px;
  color: var(--ant-color-primary);
}
.ub-text {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.right {
  flex: 1;
  min-width: 0;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ---------- 工具栏 ---------- */
.toolbar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 56px;
  padding: 0 16px;
  background: var(--ant-color-bg-container);
  border: 1px solid var(--ant-color-border-secondary);
  border-radius: var(--ant-radius-lg);
}
.tb-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.title {
  font-size: 16px;
  font-weight: 600;
  color: var(--ant-color-text);
  line-height: 1;
}
.tb-sep {
  width: 1px;
  height: 14px;
  background: var(--ant-color-border);
}
.count {
  font-size: 12px;
  color: var(--ant-color-text-tertiary);
  font-family: var(--ant-font-family-code);
}
.tb-right {
  display: flex;
  align-items: center;
  gap: 16px;
}
.speed {
  font-size: 12px;
  font-weight: 600;
  color: var(--ant-color-text-secondary);
  font-family: var(--ant-font-family-code);
  padding: 4px 10px;
  border-radius: var(--ant-radius);
  background: var(--ant-color-fill-panel);
}
.speed.idle {
  color: var(--ant-color-text-quaternary);
  background: transparent;
}
.tb-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}
/* 搜索与排序都是工具栏里的辅助控件：给固定宽度，窄窗口下靠 tb-left 自己的
   min-width/省略号收，不把「新建下载」挤出工具栏。 */
.tb-search {
  flex: none;
  width: 210px;
}
.tb-sort {
  flex: none;
  width: 112px;
}
/* 工具栏在窄窗口下先让搜索框瘦身，保证「新建下载」永远在可视区内 */
@media (max-width: 1220px) {
  .tb-search {
    width: 150px;
  }
}

/* ---------- 移除确认 ---------- */
.rm {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 4px;
}
.rm-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--ant-color-text);
  word-break: break-all;
}
.rm-hint {
  font-size: 12px;
  line-height: 1.7;
  color: var(--ant-color-text-tertiary);
}
.rm-warn {
  font-size: 12px;
  line-height: 1.7;
  color: var(--ant-color-warning);
}

/* ---------- 内容分栏：左表右详情，两块独立白卡 ---------- */
/*
 * 列宽变量。表头和 TaskRow 的行都读这里，宽度只有一份定义。
 * 只有「名称」会伸缩，其余列定宽——定宽列之和 + 最小名称宽度必须容得下
 * 最窄窗口（1080px 时列表面板约 490px），否则行会撑破面板，出现横向滚动条，
 * 右侧的状态和操作就被裁没了。
 */
.split {
  --col-ic: 20px;
  --col-prog: 144px;
  --col-tag: 64px;
  --col-act: 112px;
  --col-gap: 10px;
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 12px;
}
.panel {
  background: var(--ant-color-bg-container);
  border: 1px solid var(--ant-color-border-secondary);
  border-radius: var(--ant-radius-lg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
/* 列表面板同时是容器查询的基准：窄到放不下状态列时由行组件自己收掉它 */
.list-panel {
  flex: 1;
  min-width: 0;
  container: fdlist / inline-size;
}
.detail-panel {
  flex: none;
  width: 320px;
}
/* 宽窗口才有资格给详情卡更多呼吸空间 */
@media (min-width: 1500px) {
  .detail-panel {
    width: 380px;
  }
}

/* ---------- 任务表 ---------- */
.th {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--col-gap);
  padding: 0 10px;
  height: 34px;
  background: var(--ant-color-fill-panel);
  border-bottom-style: solid;
  border-bottom-width: 1px;
  border-bottom-color: var(--ant-color-border-secondary);
  font-size: 12px;
  color: var(--ant-color-text-tertiary);
}
.list {
  flex: 1;
  min-height: 0;
  /* 只允许纵向滚动。横向溢出曾经来自定宽列之和超过面板宽度，
     现在列宽自适应了，这里显式关掉，杜绝再出现那条裁按钮的滚动条。 */
  overflow-y: auto;
  overflow-x: hidden;
}
.empty-wrap {
  padding: 72px 0;
}

/* 表头列。宽度全部引用 --col-*，与 TaskRow 的 .cell-* 一一对应 */
.c-ic {
  flex: none;
  width: var(--col-ic);
}
.c-name {
  flex: 1;
  min-width: 0;
}
.c-prog {
  flex: none;
  width: var(--col-prog);
  text-align: right;
}
.c-tag {
  flex: none;
  width: var(--col-tag);
  text-align: center;
}
.c-act {
  flex: none;
  width: var(--col-act);
  text-align: right;
}
@container fdlist (max-width: 560px) {
  .c-tag {
    display: none;
  }
}

/* ---------- 状态栏 ---------- */
.statusbar {
  flex: none;
  height: 32px;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 16px;
  background: var(--ant-color-bg-layout);
  border-top-style: solid;
  border-top-width: 1px;
  border-top-color: var(--ant-color-border-secondary);
  font-size: 12px;
}
.statusbar .left {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--ant-color-text-secondary);
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 3px;
  background: var(--ant-color-text-quaternary);
}
.dot.on {
  background: var(--ant-color-primary);
}
.statusbar .mid,
.statusbar .right- {
  font-family: var(--ant-font-family-code);
  color: var(--ant-color-text-tertiary);
}
.statusbar .mid {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.statusbar .right- {
  flex: none;
}

/* ---------- 关于 ---------- */
.about {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.about-head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.about-logo {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--ant-radius);
  background: var(--ant-color-primary);
  color: var(--ant-color-primary-text);
  font-size: 20px;
}
.about-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--ant-color-text);
}
.about-ver {
  font-size: 12px;
  color: var(--ant-color-text-tertiary);
  font-family: var(--ant-font-family-code);
}
.about-desc {
  font-size: 13px;
  line-height: 1.7;
  color: var(--ant-color-text-secondary);
}
.about-desc code {
  font-family: var(--ant-font-family-code);
  font-size: 12px;
}
.about-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--ant-color-text-tertiary);
}
.about-update {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-top: 12px;
  border-top: 1px solid var(--ant-color-border-secondary);
}
.about-update-text {
  font-size: 12px;
  color: var(--ant-color-text-secondary);
}
.about-update-err {
  font-size: 12px;
  color: var(--ant-color-error);
}
</style>
