<script setup lang="ts">
/**
 * 右侧详情面板：
 * 标题 → 状态徽标 → 操作按钮 → 失败原因 → 总进度 → 分段卡（含线程数调节）
 * → 4 格统计 → 校验和 → URL → 保存路径。
 *
 * 空态（没有任务 / 没选中）给引导而不是白屏，和老版一致。
 *
 * 这张面板本身已经是白卡（AppShell 的 .panel），所以里面的子区块不能再是白卡——
 * 白卡坐白卡只有描边，层级就没了。子区块用 fill-quaternary 的浅底 + 无描边，
 * 靠明度差分层，比再加一圈边框干净。
 */
import { computed, ref, watch } from 'vue'
import {
  CaretRightFilled,
  DeleteOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  PauseOutlined,
  ReloadOutlined,
  DownOutlined,
  LinkOutlined,
} from '@ant-design/icons-vue'
import { Button, Input, InputNumber, message, Progress, Spin } from 'ant-design-vue'
import type { TaskDef, TaskSnapshot, TaskState } from '../../shared/types'
import { normalizeChecksum } from '../../shared/types'
import { fmtEta, fmtSize, fmtSpeed, fmtTime } from '../../shared/format'
import { explainError } from '../../shared/errors'
import { percentText, progressRatio, statusBadge, totalBytes } from '../status'
import { report, reportRejection, useAppStore } from '../store'
import StatusTag from './StatusTag.vue'
import SegmentBar from './SegmentBar.vue'

const props = defineProps<{
  def: TaskDef | null
  snap: TaskSnapshot | null
  /** 列表里到底有没有任务。空态文案要区分「没任务」和「没选中」。 */
  hasTasks: boolean
}>()
const emit = defineEmits<{ add: []; action: [action: string] }>()
const store = useAppStore()

/**
 * 线程数改动：主进程同时写给存活的引擎和持久化的 def，所以这里只管报结果。
 * InputNumber 被清空时给出 null，回落到当前值，不能把空值发给主进程。
 */
async function setThreads(v: number | string | null): Promise<void> {
  const def = props.def
  if (!def || v === null) return
  // antd 的 change 值可能是字符串（用户在框里手打了数字）
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return
  const clamped = Math.max(1, Math.min(32, n))
  if (clamped === def.threads) return
  try {
    report(await window.fd.setThreads(def.id, clamped))
  } catch (e) {
    reportRejection(e)
  }
}

/**
 * 分段进度列表。引擎没在跑（重启后）时 segments 是空数组，按线程数补一排：
 * 已完成的任务补满格，否则一个 100% 的任务下面挂着四条 0% 的灰条，
 * 看起来像进度记录被清空了。
 */
const segValues = computed(() => {
  if (props.snap?.segments.length) return props.snap.segments.map((s) => s.progress)
  const n = Math.max(1, props.snap?.threads ?? props.def?.threads ?? 1)
  const full = (props.snap?.state || props.def?.state) === 'done'
  return Array.from({ length: n }, () => (full ? 1 : 0))
})

const segCount = computed(() =>
  props.snap && props.snap.segments.length ? props.snap.segments.length : (props.def?.threads ?? 0),
)

const name = computed(() => {
  if (!props.def) return ''
  const d = props.def.dest
  const i = Math.max(d.lastIndexOf('\\'), d.lastIndexOf('/'))
  return (i >= 0 ? d.slice(i + 1) : d) || props.def.url
})

const state = computed<TaskState>(() => props.snap?.state || props.def?.state || 'queued')
const total = computed(() => totalBytes(props.snap, props.def?.total ?? 0))
/** 服务器没报 Content-Length（chunked）：total 恒为 0，下完才变成真实字节数。 */
const sizeKnown = computed(() => total.value > 0)
/** 字节已写完、引擎正在算哈希。它不是新的 TaskState，只是下载中的一个处境。 */
const verifying = computed(() => props.snap?.verifying === true)
const ratio = computed(() => progressRatio(props.snap, props.def))
const pctText = computed(() => percentText(ratio.value))
const pct = computed(() => Number(((ratio.value ?? 0) * 100).toFixed(1)))
const isDone = computed(() => state.value === 'done')
const isRunning = computed(() => state.value === 'downloading' || state.value === 'preparing')
/** 详情卡的徽标列没有定宽约束，用长文案把处境说全。 */
const badge = computed(() => statusBadge(state.value, props.snap, props.def, false))
/** 真在下字节却没有总长：进度条改画不定量动画，不摆假的 0%。 */
const indeterminate = computed(() => !sizeKnown.value && !verifying.value && isRunning.value)
/** 校验中不给 antd 的 success：字节是到齐了，但还没核对完，绿色等于提前宣布成功。 */
const barStatus = computed(() => (verifying.value ? 'active' : undefined))

/**
 * 统计口径。重启后引擎没跑，snap 可能为空——这时要回落落到盘的 def，
 * 否则详情卡会满屏破折号，看起来像任务记录丢了。
 */
const stats = computed(() => {
  const s = props.snap
  const d = props.def
  const downloaded = s?.downloaded ?? d?.downloaded ?? 0
  const finishedAt = s?.finished_at || d?.finished_at || 0
  const running = state.value === 'downloading'
  return [
    { label: '已下载', value: fmtSize(downloaded) },
    // 「—」在这张卡里的意思是「还没拿到数」，而未知长度的意思是「拿不到数」，
    // 两者必须分开写，否则用户以为刷新一下就有了。
    { label: '总计', value: sizeKnown.value ? fmtSize(total.value) : running ? '大小未知' : '—' },
    // 校验期间速度是上一条的残留值（字节早就不动了），宁可不摆
    { label: '速度', value: running && s && !verifying.value ? fmtSpeed(s.speed) : '—' },
    running && !verifying.value
      ? { label: '剩余时间', value: sizeKnown.value ? fmtEta(s?.eta ?? 0) : '算不出来' }
      : { label: '完成时间', value: finishedAt ? fmtTime(finishedAt) : '—' },
  ]
})

/**
 * 失败原因。这里摆全三样：中文标题、下一步建议、引擎原文。
 *
 * 列表行只放得下一句话，而「为什么失败、现在该做什么」必须有个完整交代的地方。
 * 原文留着是为了截图问人——翻译是为了让人看懂，不是为了把信息藏起来。
 */
const failure = computed(() => {
  if (state.value !== 'error') return null
  return explainError(props.snap?.error || props.def?.error || '')
})

/**
 * 只要没在跑，主按钮就该能点。以前写成 `!isRunning && !isDone`，
 * 于是已完成的行上「重新下载」是灰的——那恰恰是唯一能触发重下的行。
 */
const canStart = computed(() => !isRunning.value)
/** 主按钮：完成 → 重新下载；其余没在跑的 → 从断点继续。 */
const primaryLabel = computed(() => {
  if (isDone.value) return '重新下载'
  if (state.value === 'error' || state.value === 'cancelled') return '继续下载'
  if (state.value === 'paused') return '恢复下载'
  return '开始下载'
})
const primaryAction = computed(() => (isDone.value ? 'retry' : 'start'))

// ------------------------------------------------------------------ 校验和

/**
 * 站点上的 md5 常常是下完才回去看到的，所以这里必须能事后补。
 * 没有这条入口，校验和就等于「新建时忘了填，那一份十几个 GB 再也验不了」。
 */
const checksumAlg = computed(() => (props.def?.checksum || '').split(':')[0])
/** 引擎只在算对之后才发 done，所以 done + 有校验和 就等于「这一份就是服务器那一份」。 */
const verifiedDone = computed(() => isDone.value && !!props.def?.checksum)

/** 草稿跟着选中的任务走；切到另一条时重新取值，不拿上一条的哈希继续编辑。 */
const csDraft = ref('')
watch(
  () => props.def?.id,
  () => {
    csDraft.value = props.def?.checksum ?? ''
  },
  { immediate: true },
)

/** 本地先判一次：读不懂就别发出去，主进程那道拒绝是最后的保险，不是提示文案。 */
const csError = computed(() =>
  normalizeChecksum(csDraft.value) === null
    ? '读不懂这串校验和：需要 32 位（MD5）/ 40 位（SHA-1）/ 64 位（SHA-256）十六进制，或写成 sha256:… 的形式'
    : '',
)
const csUnchanged = computed(() => csDraft.value.trim() === (props.def?.checksum ?? ''))

async function saveChecksum(): Promise<void> {
  const def = props.def
  if (!def || csError.value || csUnchanged.value) return
  // 空串是「不校验」，不是「没填」——发给主进程就是清掉这条任务的校验
  const value = normalizeChecksum(csDraft.value) ?? ''
  try {
    // 主进程拒绝时由 report() 把它的原文抛出来，这里不另编一句
    if (!report(await window.fd.setChecksum(def.id, value))) return
    csDraft.value = value
    message.success(value ? '校验和已保存，下一轮下载生效' : '已取消校验，下一轮下载生效')
    // def.checksum 要等下一次回询才随 rows 回来；主动拉一次，免得卡上仍挂着
    // 旧哈希，看起来像没保存。
    await store.refreshDefs()
  } catch (e) {
    reportRejection(e)
  }
}
</script>

<template>
  <div class="detail">
    <!-- 空态分两种：任务列表本来就是空的，还是有任务但没选中。混成一句话
         会让「列表有三行、右侧却说还没有任务」看起来像数据丢了。 -->
    <div v-if="!def" class="empty">
      <div class="empty-icon"><DownOutlined /></div>
      <div class="empty-title">{{ hasTasks ? '未选中任务' : '还没有下载任务' }}</div>
      <div class="empty-hint">
        <template v-if="hasTasks">
          在左侧列表点击任意一行<br />这里会显示分段进度、速度与下载链接
        </template>
        <template v-else>
          多线程分段下载 · 断点续传 · 暂停恢复<br />
          点击「新建下载」粘贴链接，或按 Ctrl+N
        </template>
      </div>
      <Button type="primary" @click="emit('add')">新建下载</Button>
    </div>

    <!-- 已选中：标题区 → 总进度 → 分段 → 统计 → 校验和 → 链接 -->
    <template v-else>
      <header class="head">
        <div class="title">{{ name }}</div>
        <div class="badge-row">
          <StatusTag :state="state" :badge="badge" />
          <!-- 校验中没有速度也没有剩余时间可看，得单独说清此刻在做什么，
               否则一个停在 100% 的条看起来就是「卡住了」。 -->
          <span v-if="verifying" class="spin-wrap">
            <Spin size="small" /> 字节已下完，正在算哈希
          </span>
          <span v-else-if="state === 'preparing'" class="spin-wrap">
            <Spin size="small" /> 准备中
          </span>
        </div>
        <!-- 操作区：行上的图标按钮只有 tooltip 没有文字，新用户认不出哪个是移除。
             这里用带文字的按钮，把「继续 / 重新下载 / 打开 / 移除」说清楚。 -->
        <div class="acts">
          <Button
            size="small"
            type="primary"
            class="act-primary"
            :disabled="!canStart"
            @click="emit('action', primaryAction)"
          >
            <template #icon>
              <ReloadOutlined v-if="isDone" />
              <CaretRightFilled v-else />
            </template>
            {{ primaryLabel }}
          </Button>
          <Button size="small" :disabled="!isRunning" @click="emit('action', 'pause')">
            <template #icon><PauseOutlined /></template>
            暂停
          </Button>
          <Button size="small" :disabled="!isDone" @click="emit('action', 'open-file')">
            <template #icon><FileTextOutlined /></template>
            打开文件
          </Button>
          <Button size="small" @click="emit('action', 'open')">
            <template #icon><FolderOpenOutlined /></template>
            打开目录
          </Button>
          <Button size="small" danger @click="emit('action', 'remove')">
            <template #icon><DeleteOutlined /></template>
            移除
          </Button>
        </div>
      </header>

      <!-- 失败原因：中文标题 + 该做什么 + 引擎原文。三样都必要，缺一样
           用户就只能靠猜或者去翻日志。 -->
      <div v-if="failure" class="blk failure">
        <div class="fail-title">{{ failure.title }}</div>
        <div v-if="failure.advice" class="fail-advice">{{ failure.advice }}</div>
        <div class="fail-raw">引擎原文：{{ failure.raw }}</div>
      </div>

      <div class="blk">
        <div class="blk-head">
          <span class="blk-label">总进度</span>
          <span class="blk-value">{{ pctText }}</span>
        </div>
        <!-- 没有总长就没有百分比可给：画一条不定量动画，而不是摆一个假的 0% -->
        <div v-if="indeterminate" class="indet-track"><span class="indet-fill" /></div>
        <Progress
          v-else
          :percent="pct"
          :status="barStatus"
          :show-info="false"
          :stroke-width="8"
          :format="() => ''"
          class="total-bar"
        />
        <div v-if="indeterminate" class="blk-hint">
          这台服务器没报文件大小，所以这里没有百分比可给，只看已下载量；下完才知道总共多少
        </div>
        <div v-else-if="verifying" class="blk-hint">
          字节已经全部落盘，正在算哈希。一份 8 GB 的合集要几十秒，这段时间进度就一直停在 100%
        </div>
      </div>

      <div class="blk">
        <div class="blk-head">
          <span class="blk-label">分段下载（{{ segCount || '—' }} 段）</span>
          <span class="thread-ctl">
            <span class="blk-label">线程</span>
            <InputNumber
              size="small"
              :value="def.threads"
              :min="1"
              :max="32"
              @change="setThreads"
            />
          </span>
        </div>
        <SegmentBar :values="segValues" :height="14" />
        <div class="thread-hint">引擎只在暂停状态下改线程数，会按已下载字节重算分段；下载中调整要等下次启动生效</div>
      </div>

      <div class="stat-grid">
        <div v-for="s in stats" :key="s.label" class="stat-cell">
          <div class="stat-label">{{ s.label }}</div>
          <div class="stat-value">{{ s.value }}</div>
        </div>
      </div>

      <!-- 校验和：站点常常是下完才回去看到的，所以这条要能事后补、也能清空。
           正在跑的那一轮改不了（引擎已经带着旧值在下），所以提示里写明生效时机。 -->
      <div class="blk">
        <div class="blk-head">
          <span class="blk-label">校验和</span>
          <span class="blk-value">{{ checksumAlg || '不校验' }}</span>
        </div>
        <div class="cs-row">
          <Input
            v-model:value="csDraft"
            size="small"
            class="mono"
            placeholder="md5 / sha1 / sha256，可只贴十六进制"
            allow-clear
          />
          <Button size="small" type="primary" :disabled="!!csError || csUnchanged" @click="saveChecksum">
            保存
          </Button>
        </div>
        <div v-if="csError" class="cs-error">{{ csError }}</div>
        <div v-else-if="verifiedDone" class="cs-ok">已按 {{ checksumAlg }} 校验通过，这就是服务器那一份文件。</div>
        <div class="blk-hint">留空 = 不校验；改动下一轮下载才生效，正在跑的这一轮仍按原值核对。</div>
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

/* ---------- 操作区 ----------
 * 详情卡只有 320~380px 宽，五个按钮硬排一行必然换行错位。这里用两列网格：
 * 主按钮横跨两列（它是这一屏唯一必要的动作），其余四个正好铺满 2×2，
 * 位置固定，不会因为文件名长短或深浅色而跳动。
 */
.acts {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px;
}
.acts :deep(.ant-btn) {
  width: 100%;
  justify-content: flex-start;
}
.acts > .act-primary {
  grid-column: 1 / -1;
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
/* 不定量条：没有总长就没有百分比可画，停在 0% 看起来像没开始下。
   只动 transform，轨道宽度是 100%，卡片的两栏对齐不受影响。 */
.indet-track {
  height: 8px;
  border-radius: 4px;
  background: var(--ant-color-fill-bar);
  overflow: hidden;
}
.indet-fill {
  display: block;
  height: 100%;
  width: 35%;
  border-radius: 4px;
  background: var(--ant-color-primary);
  animation: indet-slide 1.3s ease-in-out infinite alternate;
}
@keyframes indet-slide {
  from {
    transform: translateX(-20%);
  }
  to {
    transform: translateX(285%);
  }
}
/* 区块里的小字说明：只解释「为什么这里没有数字」这种看代码也猜不到的行为 */
.blk-hint {
  font-size: 11px;
  line-height: 1.6;
  color: var(--ant-color-text-quaternary);
}

/* ---------- 失败原因 ----------
 * 报错卡必须是这一屏最先看到的东西，所以放在总进度之上，并且用 error 底色
 * 和左边的强调条区别于普通区块。原文用等宽小字，方便截图问人时能逐字对上。
 */
.blk.failure {
  background: var(--ant-color-error-bg);
  border-left: 3px solid var(--ant-color-error);
  gap: 6px;
}
.fail-title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
  color: var(--ant-color-error);
}
.fail-advice {
  font-size: 12px;
  line-height: 1.7;
  color: var(--ant-color-text-secondary);
}
.fail-raw {
  font-size: 11px;
  line-height: 1.6;
  color: var(--ant-color-text-tertiary);
  font-family: var(--ant-font-family-code);
  word-break: break-all;
  user-select: text;
}

/* ---------- 线程数调节 ---------- */
.thread-ctl {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.thread-hint {
  font-size: 11px;
  line-height: 1.6;
  color: var(--ant-color-text-quaternary);
}

/* ---------- 校验和 ----------
 * 64 位十六进制比这张卡还宽：输入框吃掉剩余宽度（内部横向滚动），
 * 「保存」定宽留在右边，不然它会被长哈希挤到下一行去。
 */
.cs-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
/* class 落在 antd Input 的根元素上，所以定宽/伸缩都直接给它 */
.cs-row .mono {
  flex: 1;
  min-width: 0;
  font-family: var(--ant-font-family-code);
}
.cs-row :deep(.ant-btn) {
  flex: none;
}
.cs-error {
  font-size: 11px;
  line-height: 1.6;
  color: var(--ant-color-error);
}
.cs-ok {
  font-size: 12px;
  line-height: 1.6;
  color: var(--ant-color-success);
}

/* ---------- 统计网格 ---------- */
.stat-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
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
