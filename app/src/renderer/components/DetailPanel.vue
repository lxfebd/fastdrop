<script setup lang="ts">
/**
 * 右侧详情面板：
 * 标题 → 状态徽标 → 分段卡 → 6 格统计 → URL → 保存路径。
 *
 * 空态（没有任务 / 没选中）给引导而不是白屏，和老版一致。
 *
 * 这张面板本身已经是白卡（AppShell 的 .panel），所以里面的子区块不能再是白卡——
 * 白卡坐白卡只有描边，层级就没了。子区块用 fill-quaternary 的浅底 + 无描边，
 * 靠明度差分层，比再加一圈边框干净。
 */
import { computed } from 'vue'
import { DownOutlined, LinkOutlined } from '@ant-design/icons-vue'
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
const pct = computed(() => Math.max(0, Math.min(100, (props.snap?.progress ?? 0) * 100)))

/** 6 格统计。顺序固定为：已下载/总计/速度/剩余时间/分段/线程。 */
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
        点击「新建下载」粘贴链接，或按 Ctrl+N
      </div>
      <Button type="primary" @click="emit('add')">新建下载</Button>
    </div>

    <!-- 已选中：标题区 → 总进度 → 分段 → 统计 → 链接 -->
    <template v-else>
      <header class="head">
        <div class="title">{{ name }}</div>
        <div class="badge-row">
          <StatusTag :state="state" />
          <span v-if="state === 'preparing'" class="spin-wrap">
            <Spin size="small" /> 准备中
          </span>
        </div>
      </header>

      <div class="blk">
        <div class="blk-head">
          <span class="blk-label">总进度</span>
          <span class="blk-value">{{ pct.toFixed(1) }}%</span>
        </div>
        <Progress
          :percent="Number(pct.toFixed(1))"
          :show-info="false"
          :stroke-width="8"
          :format="() => ''"
          class="total-bar"
        />
      </div>

      <div class="blk">
        <div class="blk-head">
          <span class="blk-label">分段下载</span>
          <span class="blk-value">{{ segCount || '—' }} 线程</span>
        </div>
        <SegmentBar :values="segValues" :height="14" />
      </div>

      <div class="stat-grid">
        <div v-for="s in stats" :key="s.label" class="stat-cell">
          <div class="stat-label">{{ s.label }}</div>
          <div class="stat-value">{{ s.value }}</div>
        </div>
      </div>

      <div class="blk link-blk">
        <div class="link-row">
          <LinkOutlined class="link-ic" />
          <div>
            <div class="blk-label">下载链接</div>
            <div class="url">{{ def.url }}</div>
          </div>
        </div>
        <div class="link-row">
          <span class="link-ic dot" />
          <div>
            <div class="blk-label">保存位置</div>
            <div class="path">{{ def.dest }}</div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.detail {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
  overflow-y: auto;
}

/* ---------- 标题区 ---------- */
.head {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-bottom: 14px;
  border-bottom-style: solid;
  border-bottom-width: 1px;
  border-bottom-color: var(--ant-color-border-secondary);
}
.title {
  font-size: 16px;
  font-weight: 600;
  line-height: 1.4;
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

/* ---------- 区块：浅底无描边，靠明度差和面板分层 ---------- */
.blk {
  background: var(--ant-color-fill-panel);
  border-radius: var(--ant-radius);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.blk-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.blk-label {
  font-size: 12px;
  color: var(--ant-color-text-tertiary);
}
.blk-value {
  font-size: 12px;
  font-weight: 600;
  color: var(--ant-color-text-secondary);
  font-family: var(--ant-font-family-code);
}
.total-bar {
  margin-bottom: 0;
}

/* ---------- 统计网格 ---------- */
.stat-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}
.stat-cell {
  background: var(--ant-color-bg-container);
  border: 1px solid var(--ant-color-border-secondary);
  border-radius: var(--ant-radius);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.stat-label {
  font-size: 12px;
  color: var(--ant-color-text-tertiary);
}
.stat-value {
  font-size: 14px;
  font-weight: 600;
  color: var(--ant-color-text);
  font-family: var(--ant-font-family-code);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---------- 链接区 ---------- */
.link-blk {
  gap: 12px;
}
.link-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.link-ic {
  flex: none;
  width: 16px;
  text-align: center;
  font-size: 13px;
  color: var(--ant-color-text-tertiary);
  margin-top: 2px;
}
.link-ic.dot {
  width: 3px;
  height: 3px;
  border-radius: 2px;
  background: var(--ant-color-text-quaternary);
  margin-top: 7px;
}
.url {
  font-size: 12px;
  line-height: 1.6;
  color: var(--ant-color-text-secondary);
  font-family: var(--ant-font-family-code);
  word-break: break-all;
  user-select: text;
}
.path {
  font-size: 12px;
  line-height: 1.6;
  color: var(--ant-color-text-tertiary);
  font-family: var(--ant-font-family-code);
  word-break: break-all;
  user-select: text;
}

/* ---------- 空态 ---------- */
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
  border-radius: var(--ant-radius);
  background: var(--ant-color-primary-bg);
  color: var(--ant-color-primary);
  font-size: 22px;
}
.empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--ant-color-text);
}
.empty-hint {
  font-size: 12px;
  color: var(--ant-color-text-tertiary);
  line-height: 1.8;
}
</style>
