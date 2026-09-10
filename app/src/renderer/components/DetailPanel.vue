<script setup lang="ts">
/**
 * 右侧详情面板。对应 fastdrop/ui_main.py 的 DetailCard + DetailPanel：
 * 标题 → 状态徽标 → 分段卡 → 6 格统计 → URL → 保存路径。
 *
 * 空态（没有任务 / 没选中）给引导而不是白屏，和老版一致。
 */
import { computed } from 'vue'
import { DownOutlined } from '@ant-design/icons-vue'
import { Button, Progress, Spin } from 'ant-design-vue'
import type { TaskDef, TaskSnapshot } from '../../shared/types'
import { fmtEta, fmtSize, fmtSpeed } from '../../shared/format'
import StatusTag from './StatusTag.vue'
import SegmentBar from './SegmentBar.vue'

const props = defineProps<{
  def: TaskDef | null
  snap: TaskSnapshot | null
}>()
const emit = defineEmits<{ add: [] }>()

/** 分段进度列表。引擎发空数组时退化成全 0。 */
const segValues = computed(() =>
  props.snap && props.snap.segments.length
    ? props.snap.segments.map((s) => s.progress)
    : Array.from({ length: Math.max(1, props.def?.threads ?? 8) }, () => 0),
)

const segCount = computed(() =>
  props.snap && props.snap.segments.length ? props.snap.segments.length : (props.def?.threads ?? 0),
)

const name = computed(() => {
  if (!props.def) return ''
  const d = props.def.dest
  const i = Math.max(d.lastIndexOf('\\'), d.lastIndexOf('/'))
  return (i >= 0 ? d.slice(i + 1) : d) || props.def.url
})

const state = computed(() => props.snap?.state ?? 'queued')

/** 6 格统计。顺序和 Python 版一致：已下载/总计/速度/剩余时间/分段/线程。 */
const stats = computed(() => {
  const s = props.snap
  return [
    { label: '已下载', value: s ? fmtSize(s.downloaded) : '—' },
    { label: '总计', value: s ? fmtSize(s.total) : '—' },
    { label: '速度', value: s && state.value === 'downloading' ? fmtSpeed(s.speed) : '—' },
    { label: '剩余时间', value: s && state.value === 'downloading' ? fmtEta(s.eta) : '—' },
    { label: '分段', value: segCount.value ? String(segCount.value) : '—' },
    { label: '线程', value: props.def ? String(props.def.threads) : '—' },
  ]
})
</script>

<template>
  <div class="detail">
    <!-- 空态：没有任务时引导新建 -->
    <div v-if="!def" class="empty">
      <div class="empty-icon"><DownOutlined /></div>
      <div class="empty-title">还没有下载任务</div>
      <div class="empty-hint">
        多线程分段下载 · 断点续传 · 暂停恢复<br />
        点击右上角「新建下载」粘贴链接，或按 Ctrl+N
      </div>
      <Button type="primary" @click="emit('add')">新建下载</Button>
    </div>

    <!-- 已选中但引擎还在准备：快照为空，显示骨架提示 -->
    <template v-else>
      <div class="title">{{ name }}</div>

      <div class="badge-row">
        <StatusTag :state="state" />
        <span v-if="state === 'preparing'" class="spin-wrap">
          <Spin size="small" /> 准备中
        </span>
      </div>

      <div class="card seg-card">
        <div class="card-head">
          <span class="card-label">分段下载</span>
          <span class="seg-label">{{ segCount || '—' }} 线程</span>
        </div>
        <SegmentBar :values="segValues" :height="18" />
        <Progress
          :percent="Number(((snap?.progress ?? 0) * 100).toFixed(1))"
          :show-info="false"
          :stroke-width="5"
          class="total-bar"
        />
      </div>

      <div class="stat-grid">
        <div v-for="s in stats" :key="s.label" class="stat-cell">
          <div class="stat-label">{{ s.label }}</div>
          <div class="stat-value">{{ s.value }}</div>
        </div>
      </div>

      <div class="card url-card">
        <div class="card-label">URL</div>
        <div class="url">{{ def.url }}</div>
      </div>

      <div class="path">{{ def.dest }}</div>
    </template>
  </div>
</template>

<style scoped>
.detail {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  height: 100%;
  overflow-y: auto;
}
.title {
  font-size: 15px;
  font-weight: 600;
  color: var(--ant-color-text);
  word-break: break-all;
}
.badge-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.spin-wrap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--ant-color-text-tertiary);
}

.card {
  border: 1px solid var(--ant-color-border);
  border-radius: 8px;
  background: var(--ant-color-bg-container);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.card-label {
  font-size: 11px;
  color: var(--ant-color-text-tertiary);
}
.seg-label {
  font-size: 11px;
  color: var(--ant-color-text-tertiary);
  font-family: var(--ant-font-family-code);
}
.total-bar {
  margin-bottom: 0;
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
.stat-cell {
  border: 1px solid var(--ant-color-border);
  border-radius: 8px;
  background: var(--ant-color-bg-container);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.stat-label {
  font-size: 11px;
  color: var(--ant-color-text-tertiary);
}
.stat-value {
  font-size: 13px;
  font-weight: 600;
  color: var(--ant-color-text);
  font-family: var(--ant-font-family-code);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.url {
  font-size: 11px;
  color: var(--ant-color-text-secondary);
  font-family: var(--ant-font-family-code);
  word-break: break-all;
  user-select: text;
}
.path {
  font-size: 11px;
  color: var(--ant-color-text-tertiary);
  font-family: var(--ant-font-family-code);
  word-break: break-all;
  user-select: text;
}

.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  text-align: center;
}
.empty-icon {
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: var(--ant-color-primary-bg);
  color: var(--ant-color-primary);
  font-size: 22px;
}
.empty-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--ant-color-text);
}
.empty-hint {
  font-size: 12px;
  color: var(--ant-color-text-tertiary);
  line-height: 1.7;
}
</style>
