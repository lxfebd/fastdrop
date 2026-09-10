<script setup lang="ts">
/**
 * 单行任务：
 * 图标 + 名称/副标题（两行堆叠，定宽）+ 大小 + 进度条 + 百分比 + 速度 + 状态 + 操作。
 *
 * 列宽和 AppShell 的表头 .c-* 一一对应，两处一起改。用固定 px 而不是百分比，
 * 保证长文件名不会把整行挤爆（和 Qt 版的 setFixedWidth 同一个考虑）。
 *
 * 列首的 36px 让位给图标：cell-ic 占 24px + gap 12px，所以 cell-lead 用
 * padding-left 顶到同一位置，名称文字才和表头「名称」对齐。
 */
import { computed, type Component } from 'vue'
import {
  CaretRightFilled,
  CheckCircleFilled,
  CloseCircleFilled,
  DeleteOutlined,
  ExclamationCircleOutlined,
  FolderOpenOutlined,
  PauseOutlined,
  PlayCircleFilled,
} from '@ant-design/icons-vue'
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
  if (state.value === 'downloading') return PlayCircleFilled
  if (state.value === 'preparing') return ExclamationCircleOutlined
  if (state.value === 'done') return CheckCircleFilled
  if (state.value === 'error') return CloseCircleFilled
  return CaretRightFilled
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
const pct = computed(() => Math.max(0, Math.min(100, (props.snap?.progress ?? 0) * 100)))

/** 副标题：下载中显示 ETA，完成显示完成时间，失败显示错误。 */
const sub = computed(() => {
  const s = props.snap
  if (!s) return `${props.def.threads} 线程`
  const n = s.segments.length
  if (state.value === 'downloading' || state.value === 'preparing') {
    // 引擎重试期间也会填 `error`（例如服务端把响应截断了）。原来这里只显示 ETA，
    // 用户会盯着「下载中 50%」空等，直到它升级成 error 态才知道出事——所以重试
    // 中的错误也要摆出来。
    const warn = s.error ? ` · ${s.error}` : ''
    return `剩余 ${fmtEta(s.eta)} · ${n} 线程 · 已下 ${fmtSize(s.downloaded)}${warn}`
  }
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
      <div class="bar">
        <div
          class="bar-fill"
          :class="{ full: pct >= 100, moving: state === 'downloading' }"
          :style="{ width: pct + '%' }"
        />
      </div>
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
  min-height: 52px;
  padding: 8px 12px;
  background: var(--ant-color-bg-container);
  cursor: pointer;
  border-bottom-style: solid;
  border-bottom-width: 1px;
  border-bottom-color: var(--ant-color-border-secondary);
}
.task-row:hover {
  background: var(--ant-color-fill-panel);
}
.task-row.selected {
  background: var(--ant-color-primary-bg);
  box-shadow: inset 2px 0 0 var(--ant-color-primary);
}
.task-row.selected:hover {
  background: var(--ant-color-primary-bg);
}

.cell-ic {
  flex: none;
  width: 24px;
  text-align: center;
  color: var(--ant-color-text-quaternary);
  font-size: 16px;
}
.cell-ic .downloading,
.cell-ic .preparing { color: var(--ant-color-primary); }
.cell-ic .done { color: var(--ant-color-success); }
.cell-ic .error { color: var(--ant-color-error); }

.cell-lead {
  flex: none;
  width: 268px;
  min-width: 0;
  padding-left: 36px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.name {
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
  color: var(--ant-color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sub {
  font-size: 12px;
  line-height: 18px;
  color: var(--ant-color-text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--ant-font-family-code);
}

.cell-size,
.cell-pct,
.cell-spd {
  text-align: right;
  font-size: 12px;
  font-family: var(--ant-font-family-code);
  color: var(--ant-color-text-secondary);
}
.cell-size { flex: none; width: 68px; }
.cell-pct { flex: none; width: 52px; }
.cell-spd { flex: none; width: 84px; }
.cell-tag {
  flex: none;
  width: 86px;
  display: flex;
  justify-content: center;
}

.cell-bar {
  flex: 1;
  min-width: 0;
}
/* 自绘进度条：antd 的 Progress 在小尺寸下对比度偏低，且列表里几十行同时跑
   transition 会掉帧，这里直接画 —— 颜色完全走 token，深浅色自动切换 */
.bar {
  height: 6px;
  border-radius: 3px;
  background: var(--ant-color-fill-bar);
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  border-radius: 3px;
  background: var(--ant-color-primary);
  /* 引擎每 100ms 推一次进度。过渡时间必须跟推送周期对齐：
     之前是 0.35s，新值进来时上一段过渡还没走完，进度条看起来一顿一顿。 */
  transition: width 0.1s linear;
}
/* 下载中用带渐层的填充，静态值会显得像「卡住」 */
.bar-fill.moving {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--ant-color-primary) 82%, var(--ant-color-bg-container)) 0%,
    var(--ant-color-primary) 100%
  );
}

.cell-actions {
  flex: none;
  width: 120px;
  display: flex;
  justify-content: flex-end;
  gap: 2px;
}
.ibtn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--ant-radius);
  background: transparent;
  color: var(--ant-color-text-tertiary);
  cursor: pointer;
  font-size: 14px;
  padding: 0;
  transition: background 0.15s, color 0.15s;
}
.ibtn:hover:not(:disabled) {
  background: var(--ant-color-fill-secondary);
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
