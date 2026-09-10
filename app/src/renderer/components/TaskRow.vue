<script setup lang="ts">
/**
 * 单行任务。对应 fastdrop/ui_main.py 的 TaskRow：
 * 图标 + 名称/副标题（两行堆叠，定宽）+ 大小 + 进度条 + 百分比 + 速度 + 状态 + 操作。
 *
 * 列宽用固定 px，和 Qt 版的 setFixedWidth 对齐，保证长文件名不会把整行挤爆。
 */
import { computed, type Component } from 'vue'
import {
  CaretRightFilled,
  CheckCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  FileOutlined,
  FolderOpenOutlined,
  PauseOutlined,
  PlayCircleOutlined,
} from '@ant-design/icons-vue'
import { Progress } from 'ant-design-vue'
import type { TaskDef, TaskSnapshot, TaskState } from '../../shared/types'
import { fmtEta, fmtProgress, fmtSize, fmtSpeed, fmtTime } from '../../shared/format'
import StatusTag from './StatusTag.vue'

const props = defineProps<{
  def: TaskDef
  snap: TaskSnapshot | null
  selected: boolean
}>()

const emit = defineEmits<{
  select: []
  action: [action: string]
}>()

/** 引擎没启动过（snap 为空）就当作排队中，和老版行为一致。 */
const state = computed<TaskState>(() => props.snap?.state ?? 'queued')

const icon: Component = computed(() => {
  if (state.value === 'downloading' || state.value === 'preparing') return PlayCircleOutlined
  if (state.value === 'done') return CheckCircleOutlined
  if (state.value === 'error') return CloseCircleOutlined
  return FileOutlined
})

/** dest 指向目录时 basename 取不到文件名，用 url 兜底。 */
const name = computed(() => {
  const d = props.def.dest
  const i = Math.max(d.lastIndexOf('\\'), d.lastIndexOf('/'))
  return (i >= 0 ? d.slice(i + 1) : d) || props.def.url
})

const dir = computed(() => {
  const d = props.def.dest
  const i = Math.max(d.lastIndexOf('\\'), d.lastIndexOf('/'))
  return i > 0 ? d.slice(0, i) : ''
})

const sizeText = computed(() => (props.snap ? fmtSize(props.snap.total) : '—'))
const pctText = computed(() => fmtProgress(props.snap?.progress ?? 0))
const speedText = computed(() =>
  state.value === 'downloading' && props.snap ? fmtSpeed(props.snap.speed) : '—',
)

/** 副标题：下载中显示 ETA，完成显示完成时间，失败显示错误。 */
const sub = computed(() => {
  const s = props.snap
  if (!s) return `${props.def.threads} 线程`
  const n = s.segments.length
  if (state.value === 'downloading' || state.value === 'preparing')
    return `剩余 ${fmtEta(s.eta)} · ${n} 线程 · 已下 ${fmtSize(s.downloaded)}`
  if (state.value === 'done') return `${n} 线程 · 完成于 ${fmtTime(s.finished_at)}`
  if (state.value === 'error') return s.error || '下载失败'
  return `${n} 线程 · 已下 ${fmtSize(s.downloaded)}`
})

const canStart = computed(() => ['queued', 'paused', 'error', 'idle', 'cancelled'].includes(state.value))
const canPause = computed(() => state.value === 'downloading' || state.value === 'preparing')
const canOpen = computed(() => state.value === 'done')
</script>

<template>
  <div class="task-row" :class="{ selected }" @click="emit('select')">
    <span class="cell-ic">
      <component :is="icon" :class="{ [state]: true }" />
    </span>

    <div class="cell-lead" :title="dir">
      <div class="name">{{ name }}</div>
      <div class="sub">{{ sub }}</div>
    </div>

    <span class="cell-size">{{ sizeText }}</span>

    <div class="cell-bar">
      <Progress :percent="Number(((snap?.progress ?? 0) * 100).toFixed(1))" :show-info="false" size="small" :stroke-width="4" />
    </div>

    <span class="cell-pct">{{ pctText }}</span>
    <span class="cell-spd">{{ speedText }}</span>

    <span class="cell-tag">
      <StatusTag :state="state" />
    </span>

    <span class="cell-actions">
      <button class="ibtn" :disabled="!canStart" title="开始 / 恢复" @click.stop="emit('action', 'start')">
        <CaretRightFilled />
      </button>
      <button class="ibtn" :disabled="!canPause" title="暂停" @click.stop="emit('action', 'pause')">
        <PauseOutlined />
      </button>
      <button class="ibtn" :disabled="!canOpen" title="打开所在文件夹" @click.stop="emit('action', 'open')">
        <FolderOpenOutlined />
      </button>
      <button class="ibtn danger" title="移除任务" @click.stop="emit('action', 'remove')">
        <DeleteOutlined />
      </button>
    </span>
  </div>
</template>

<style scoped>
.task-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 46px;
  padding: 8px 12px 8px 16px;
  border-bottom: 1px solid var(--ant-color-border-secondary);
  background: var(--ant-color-bg-container);
  cursor: pointer;
}
.task-row:hover {
  background: var(--ant-color-fill-quaternary);
}
.task-row.selected {
  background: var(--ant-color-primary-bg);
  box-shadow: inset 2px 0 0 var(--ant-color-primary);
}

.cell-ic {
  flex: none;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--ant-color-border);
  border-radius: 4px;
  color: var(--ant-color-text-secondary);
  font-size: 15px;
}
.cell-ic .downloading,
.cell-ic .preparing { color: var(--ant-color-primary); }
.cell-ic .done { color: var(--ant-color-success); }
.cell-ic .error { color: var(--ant-color-error); }

.cell-lead {
  flex: none;
  width: 268px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.name {
  font-size: 13px;
  font-weight: 500;
  color: var(--ant-color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sub {
  font-size: 11px;
  color: var(--ant-color-text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--ant-font-family-code);
}

.cell-size {
  flex: none;
  width: 68px;
  text-align: right;
  font-size: 12px;
  color: var(--ant-color-text-secondary);
  font-family: var(--ant-font-family-code);
}
.cell-bar {
  flex: 1;
  min-width: 0;
}
.cell-pct {
  flex: none;
  width: 52px;
  text-align: right;
  font-size: 12px;
  color: var(--ant-color-text-secondary);
  font-family: var(--ant-font-family-code);
}
.cell-spd {
  flex: none;
  width: 84px;
  text-align: right;
  font-size: 12px;
  color: var(--ant-color-text-secondary);
  font-family: var(--ant-font-family-code);
}
.cell-tag {
  flex: none;
  width: 86px;
  display: flex;
  justify-content: center;
}
.cell-actions {
  flex: none;
  display: flex;
  gap: 2px;
}
.ibtn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--ant-color-text-secondary);
  cursor: pointer;
  font-size: 14px;
  padding: 0;
}
.ibtn:hover:not(:disabled) {
  background: var(--ant-color-fill-tertiary);
  color: var(--ant-color-text);
}
.ibtn:disabled {
  color: var(--ant-color-text-quaternary);
  cursor: not-allowed;
}
.ibtn.danger:hover:not(:disabled) {
  color: var(--ant-color-error);
  background: var(--ant-color-error-bg);
}
</style>
