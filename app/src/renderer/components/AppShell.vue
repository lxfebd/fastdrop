<script setup lang="ts">
/**
 * 主界面骨架。对应 fastdrop/ui_main.py 的 MainWindow：
 *   侧栏 | 工具栏 + 列表/详情分栏 | 状态栏
 *
 * 这里只做布局和动作分发，展示逻辑都在子组件里。Python 版用 QSplitter 分隔
 * 列表和详情，Web 没有内建的拖拽分栏，用固定比例 + 1px 分隔线替代——拖拽调整
 * 不是下载工具的核心功能，不值得为了它引一个依赖。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { DownOutlined, InfoCircleOutlined } from '@ant-design/icons-vue'
import { Empty, Modal } from 'ant-design-vue'
import type { Settings, TaskRow } from '../../shared/types'
import { fmtProgress, fmtSpeed } from '../../shared/format'
import { matchesFilter } from '../status'
import Sidebar from './Sidebar.vue'
// 类型也叫 TaskRow，组件起个别名避免同名冲突
import TaskRowCard from './TaskRow.vue'
import DetailPanel from './DetailPanel.vue'
import NewDownloadDialog from './NewDownloadDialog.vue'
import SettingsDialog from './SettingsDialog.vue'
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

/** 状态栏右侧：走真实时钟，和老版 time.strftime 的口径一致。 */
const clock = ref('')
let tickTimer: ReturnType<typeof setInterval> | null = null

function tick(): void {
  const d = new Date()
  const pad = (x: number) => String(x).padStart(2, '0')
  clock.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}  ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

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
  tick()
  tickTimer = setInterval(tick, 1000)
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  if (tickTimer) clearInterval(tickTimer)
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="shell">
    <div class="body">
      <Sidebar :rows="state.rows" :filter="state.filter" @nav="doNav" />

      <div class="right">
        <div class="toolbar">
          <span class="title">下载管理</span>
          <span class="count">{{ countText }}</span>
          <span class="spacer" />
          <span class="speed">{{ speedText }}</span>
        </div>

        <div class="split">
          <div class="list-wrap">
            <div v-if="filteredRows.length" class="list">
              <TaskRowCard
                v-for="r in filteredRows"
                :key="r.id"
                :def="r.def"
                :snap="r.snap"
                :selected="r.id === state.selectedId"
                @select="store.select(r.id)"
                @action="(a: string) => doAction(r.id, a)"
              />
            </div>
            <Empty v-else class="empty" description="该分类下没有任务" />
          </div>

          <div class="divider" />

          <div class="detail-wrap">
            <DetailPanel :def="selectedRow?.def ?? null" :snap="selectedRow?.snap ?? null" @add="doNav('add')" />
          </div>
        </div>
      </div>
    </div>

    <div class="statusbar">
      <span class="left">{{ statusLeft }}</span>
      <span v-if="statusMid" class="mid">{{ statusMid }}</span>
      <span class="spacer" />
      <span class="right-">{{ clock }}</span>
    </div>

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
.shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--ant-color-bg-container);
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
  display: flex;
  flex-direction: column;
}
.toolbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px 12px;
}
.title {
  font-size: 16px;
  font-weight: 600;
  color: var(--ant-color-text);
}
.count {
  font-size: 12px;
  color: var(--ant-color-text-tertiary);
  font-family: var(--ant-font-family-code);
}
.speed {
  font-size: 13px;
  font-weight: 600;
  color: var(--ant-color-text);
  font-family: var(--ant-font-family-code);
}
.split {
  flex: 1;
  min-height: 0;
  display: flex;
}
.list-wrap {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.empty {
  margin: auto;
}
.divider {
  flex: none;
  width: 1px;
  background: var(--ant-color-border-secondary);
}
.detail-wrap {
  flex: none;
  width: 400px;
  min-width: 0;
  overflow: hidden;
}
.statusbar {
  flex: none;
  height: 30px;
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 0 16px;
  background: var(--ant-color-bg-layout);
  border-top: 1px solid var(--ant-color-border-secondary);
  font-size: 12px;
}
.statusbar .left {
  color: var(--ant-color-text-secondary);
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
.about {
  display: flex;
  flex-direction: column;
  gap: 14px;
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
  border-radius: 10px;
  background: var(--ant-color-primary);
  color: var(--ant-color-primary-text);
  font-size: 20px;
}
.about-name {
  font-size: 17px;
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
