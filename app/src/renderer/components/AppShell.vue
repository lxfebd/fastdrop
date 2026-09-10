<script setup lang="ts">
/**
 * 主界面骨架。对应 fastdrop/ui_main.py 的 MainWindow：
 *   侧栏 | 工具栏 + 任务表 / 详情卡 | 状态栏
 *
 * 这里只做布局和动作分发，展示逻辑都在子组件里。Python 版用 QSplitter 分隔
 * 列表和详情，Web 没有内建的拖拽分栏，用固定宽度 + 卡片边界替代——拖拽调整
 * 不是下载工具的核心功能，不值得为了它引一个依赖。
 *
 * 视觉层级（改样式前先读 theme.ts 的层级约定）：灰画布 → 白面板 → 行内表面。
 * 三个大区域（工具栏、任务表、详情）是独立白卡浮在灰底上，靠边界产生层级，
 * 而不是用 1px 线硬切。整窗同一色会让界面塌成一整块平面，那是初版的主要问题。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import {
  CaretRightFilled,
  DownOutlined,
  InfoCircleOutlined,
  PauseOutlined,
  PlusOutlined,
  ThunderboltFilled,
} from '@ant-design/icons-vue'
import { Button, Empty, Modal } from 'ant-design-vue'
import type { Settings, TaskRow } from '../../shared/types'
import { fmtProgress, fmtSpeed } from '../../shared/format'
import { matchesFilter } from '../status'
import Sidebar from './Sidebar.vue'
// 类型也叫 TaskRow，组件起个别名避免同名冲突
import TaskRowCard from './TaskRow.vue'
import DetailPanel from './DetailPanel.vue'
import NewDownloadDialog from './NewDownloadDialog.vue'
import SettingsDialog from './SettingsDialog.vue'
import ClockLabel from './ClockLabel.vue'
import GameSites from './GameSites.vue'
import { useAppStore } from '../store'

const store = useAppStore()
const { state } = store

// --------------------------------------------------------------- 派生数据

/** 当前过滤条件下的行。规则见 status.ts 的 matchesFilter。 */
const filteredRows = computed<TaskRow[]>(() =>
  state.rows.filter((r) => matchesFilter(r.snap?.state, state.filter)),
)

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

const countText = computed(() => `${counts.value.all} 个任务`)

/** 全部任务合计速度。没在跑时显示「空闲」，和老版一致。 */
const speedText = computed(() => (state.totalSpeed > 0 ? fmtSpeed(state.totalSpeed) : '空闲'))

const selectedRow = computed<TaskRow | null>(() =>
  state.rows.find((r) => r.id === state.selectedId) ?? null,
)

/** 批量按钮只在有可操作对象时可用，否则空点一次白拉一趟 IPC。 */
const hasRunning = computed(() => counts.value.downloading > 0)
const hasRunnable = computed(
  () =>
    state.rows.some(
      (r) => ['queued', 'paused', 'error', 'idle', 'cancelled'].includes(r.snap?.state ?? 'queued'),
    ),
)

/** 状态栏左侧：正在跑的优先，其次暂停、失败。 */
const statusLeft = computed(() => {
  const c = counts.value
  if (c.downloading) return `下载中 ${c.downloading} 个任务`
  if (c.paused) return `已暂停 ${c.paused} 个任务`
  if (c.error) return `${c.error} 个任务失败`
  return '就绪'
})

/** 状态栏中间：选中任务的文件名 + 进度。 */
const statusMid = computed(() => {
  const row = selectedRow.value
  if (!row || !row.snap) return ''
  const i = Math.max(row.def.dest.lastIndexOf('\\'), row.def.dest.lastIndexOf('/'))
  const name = (i >= 0 ? row.def.dest.slice(i + 1) : row.def.dest) || row.def.url
  return `${name} · ${fmtProgress(row.snap.progress)}`
})

// --------------------------------------------------------------- 对话框

const showNew = ref(false)
const showSettings = ref(false)
const showAbout = ref(false)

/** 保存设置面板里未提交的表单，SettingsDialog 内部也是从 settings 拷贝的。 */
const settingsForm = reactive<Settings>({
  threads: 8,
  download_dir: '',
  proxy: '',
  user_agent: '',
  max_concurrent: 3,
  confirm_delete: true,
  dark: true,
})

function openSettings(): void {
  if (state.settings) Object.assign(settingsForm, state.settings)
  showSettings.value = true
}

async function saveSettings(s: Settings): Promise<void> {
  try {
    await window.fd.saveSettings(s)
    Object.assign(state.settings!, s)
    showSettings.value = false
  } catch {
    // 保存失败不弹窗，下次轮询会重新拉取
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

async function onCreate(input: { url: string; dest: string; threads: number; note?: string }): Promise<void> {
  showNew.value = false
  try {
    await window.fd.addTask({
      url: normalizeUrl(input.url),
      dest: input.dest.trim(),
      threads: input.threads,
      note: input.note ?? '',
    })
    store.setFilter('all')
    await store.refreshDefs()
  } catch {
    // 主进程会返回错误，这里不额外提示
  }
}

async function clearFinished(): Promise<void> {
  await window.fd.clearFinished()
  store.select(null)
  await store.refreshDefs()
}

// --------------------------------------------------------------- 删除

async function confirmRemove(): Promise<boolean> {
  const s = state.settings
  if (!s || !s.confirm_delete) return true
  return new Promise<boolean>((resolve) => {
    Modal.confirm({
      title: '移除任务',
      content: '确定要移除这个任务吗？磁盘上已下载的文件不会删除。',
      okText: '移除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    })
  })
}

async function doAction(id: string, action: string): Promise<void> {
  switch (action) {
    case 'start':
    case 'pause':
      await window.fd.action(id, action)
      break
    case 'open':
      await window.fd.openFolder(id)
      break
    case 'remove':
      if (!(await confirmRemove())) return
      if (state.selectedId === id) store.select(null)
      await window.fd.removeTask(id)
      break
    default:
      break
  }
  await store.refreshDefs()
}

function doNav(key: string): void {
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
    case 'start-all':
      window.fd.actionAll('start')
      break
    case 'pause-all':
      window.fd.actionAll('pause')
      break
    default:
      store.setFilter(key)
  }
}

function delSelected(): void {
  if (state.selectedId) void doAction(state.selectedId, 'remove')
}

// --------------------------------------------------------------- 快捷键

/** 输入框聚焦时不拦截，否则打字会被全局快捷键截走。 */
function isEditable(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null
  if (!t || !t.tagName) return false
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable
}

function onKeydown(e: KeyboardEvent): void {
  if (isEditable(e.target)) return
  const mod = e.ctrlKey || e.metaKey
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
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="shell">
    <div class="body">
      <Sidebar :rows="state.rows" :filter="state.filter" @nav="doNav" />

      <main class="right">
        <!-- 游戏站视图：占满右侧，不显示任务列表 -->
        <GameSites v-if="state.filter === 'games'" />

        <template v-else>
          <!-- 工具栏：左标题与计数，右批量操作。动作按钮从这里进，侧栏只管导航与过滤 -->
        <div class="toolbar">
          <div class="tb-left">
            <span class="title">下载管理</span>
            <span class="tb-sep" />
            <span class="count">{{ countText }}</span>
          </div>
          <div class="tb-right">
            <span class="speed" :class="{ idle: state.totalSpeed <= 0 }">{{ speedText }}</span>
            <div class="tb-actions">
              <Button type="primary" size="small" class="btn-new" @click="doNav('add')">
                <template #icon><PlusOutlined /></template>
                新建下载
              </Button>
              <Button type="text" size="small" :disabled="!hasRunning" @click="doNav('pause-all')">
                <template #icon><PauseOutlined /></template>
                全部暂停
              </Button>
              <Button type="text" size="small" :disabled="!hasRunnable" @click="doNav('start-all')">
                <template #icon><CaretRightFilled /></template>
                全部开始
              </Button>
              <Button type="text" size="small" :disabled="!counts.done" @click="clearFinished">
                <template #icon><ThunderboltFilled /></template>
                清空已完成
              </Button>
            </div>
          </div>
        </div>

        <div class="split">
          <section class="panel list-panel">
            <!-- 表头与行共用同一套列宽，靠 padding 对齐而不是再写一遍宽度 -->
            <div class="th">
              <span class="c-name">名称</span>
              <span class="c-size">大小</span>
              <span class="c-bar" />
              <span class="c-pct">进度</span>
              <span class="c-spd">速度</span>
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
              <div v-else class="empty-wrap">
                <Empty description="该分类下没有任务" />
              </div>
            </div>
          </section>

          <section class="panel detail-panel">
            <DetailPanel
              :def="selectedRow?.def ?? null"
              :snap="selectedRow?.snap ?? null"
              @add="doNav('add')"
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

    <Modal v-model:open="showAbout" :footer="null" :width="420" @cancel="showAbout = false">
      <div class="about">
        <div class="about-head">
          <span class="about-logo"><DownOutlined /></span>
          <div>
            <div class="about-name">FastDrop</div>
            <div class="about-ver">v2.0.0 · 多线程下载管理器</div>
          </div>
        </div>
        <div class="about-desc">
          HTTP 分段并发下载，支持暂停恢复、断点续传、失败重试。
          任务配置保存在本机 <code>~/.fastdrop</code>，重启后断点不丢失。
        </div>
        <div class="about-foot">
          <InfoCircleOutlined /> Rust 引擎 · Vue 界面 · Electron 外壳
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

/* ---------- 内容分栏：左表右详情，两块独立白卡 ---------- */
.split {
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
.list-panel {
  flex: 1;
  min-width: 0;
}
.detail-panel {
  flex: none;
  width: 380px;
}

/* ---------- 任务表 ---------- */
.th {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 12px;
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
  overflow-y: auto;
}
.empty-wrap {
  padding: 72px 0;
}

/* 表头列宽。行组件的 .cell-* 必须与这里一一对应，改宽度时两处一起改 */
.c-name {
  flex: none;
  width: 268px;
  min-width: 0;
  padding-left: 36px;
  box-sizing: border-box;
}
.c-size {
  flex: none;
  width: 68px;
  text-align: right;
}
.c-bar {
  flex: 1;
  min-width: 0;
}
.c-pct {
  flex: none;
  width: 52px;
  text-align: right;
}
.c-spd {
  flex: none;
  width: 84px;
  text-align: right;
}
.c-tag {
  flex: none;
  width: 86px;
  text-align: center;
}
.c-act {
  flex: none;
  width: 120px;
  text-align: right;
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
</style>
