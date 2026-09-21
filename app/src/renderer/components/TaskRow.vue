<script setup lang="ts">
/**
 * 单行任务，四列：
 * 图标 + 名称/副标题（两行堆叠，吃掉剩余宽度）+ 进度（条 + 百分比）+ 状态 + 操作。
 *
 * 列宽写在 AppShell 的 .split 上（--col-*），表头和行走同一套变量——
 * 之前两边各写一遍 px，改一处忘一处，窄窗口下整行超出面板宽度，
 * 状态和操作被横向滚动条裁掉，看起来像「按钮没了」。
 *
 * 大小/速度不再单独占列：1080px 的最小窗口放不下八列，硬塞的结果是所有列
 * 一起被压扁。它们挪进副标题一行，信息量没丢，行宽终于能自适应。
 *
 * 「未知长度」「校验中」都不进状态列——那一列只有 64px（CDP 在量列宽），
 * 三个汉字就到边。这两件事改由副标题、进度条画法和详情卡说，见 status.ts。
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
  ReloadOutlined,
  SafetyCertificateFilled,
} from '@ant-design/icons-vue'
import type { TaskDef, TaskSnapshot, TaskState } from '../../shared/types'
import { dirName, fileName, fmtEta, fmtRange, fmtSize, fmtSpeed, fmtTime } from '../../shared/format'
import { errorLine } from '../../shared/errors'
import { percentText, progressRatio, statusBadge, totalBytes } from '../status'
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

/**
 * 引擎没启动过的任务 snap 为空（重启后只有落盘的 def），这时必须回落到
 * def.state——直接当作排队中会把已完成的任务画成「排队中 0%」。
 */
const state = computed<TaskState>(() => props.snap?.state ?? (props.def.state || 'queued'))

/**
 * 校验通过的成品任务。行首图标换一枚安全徽标当标记——状态列和图标列都是
 * `--col-*` 定宽（CDP 在量列宽），往里加字会把列撑破，只有换图标不占位置。
 */
const checksumAlg = computed(() => (props.def.checksum || '').split(':')[0])
const verifiedDone = computed(() => state.value === 'done' && !!props.def.checksum)
const verifyTip = computed(() => (verifiedDone.value ? `已按 ${checksumAlg.value} 校验通过` : ''))

const icon: Component = computed(() => {
  if (state.value === 'downloading') return PlayCircleFilled
  if (state.value === 'preparing') return ExclamationCircleOutlined
  if (state.value === 'done') return verifiedDone.value ? SafetyCertificateFilled : CheckCircleFilled
  if (state.value === 'error') return CloseCircleFilled
  return CaretRightFilled
})

const name = computed(() => fileName(props.def.dest) || props.def.url)
const dir = computed(() => dirName(props.def.dest))

/** 段数优先用引擎报的实际分段，重启后没有快照就回落到配置的线程数。 */
const segN = computed(() => props.snap?.segments.length || props.snap?.threads || props.def.threads)
const total = computed(() => totalBytes(props.snap, props.def.total))
const downloaded = computed(() => props.snap?.downloaded ?? props.def.downloaded ?? 0)
const finishedAt = computed(() => props.snap?.finished_at || props.def.finished_at)
/** 字节写完、引擎正在算哈希。它不是新的 TaskState，只是下载中的一个处境。 */
const verifying = computed(() => props.snap?.verifying === true)
/** 服务器没报 Content-Length（chunked）时总长恒为 0，百分比无从算起。 */
const sizeKnown = computed(() => total.value > 0)
const ratio = computed(() => progressRatio(props.snap, props.def))
const pctText = computed(() => percentText(ratio.value))
const pct = computed(() => Math.round((ratio.value ?? 0) * 100))
const badge = computed(() => statusBadge(state.value, props.snap, props.def, true))
/** 真在传字节、却没有总长可除：画不定量条，比停在 0% 诚实。 */
const indeterminate = computed(
  () => !sizeKnown.value && !verifying.value && (state.value === 'downloading' || state.value === 'preparing'),
)

/** 副标题：把让给列宽的信息（大小、速度）都收进这一行。 */
const sub = computed(() => {
  const got = fmtSize(downloaded.value)
  // 未知长度时单摆一个数字会被读成「文件就这么大」，写明它是已下载量。
  const range = sizeKnown.value ? fmtRange(downloaded.value, total.value) : `已下 ${got}`
  if (state.value === 'done') {
    const size = sizeKnown.value ? fmtSize(total.value) : got
    // 名称列只有两百来 px，副标题一长就变省略号。已完成的行里线程数没有
    // 意义（分段早已跑完），让位给完成时间。
    return finishedAt.value ? `${size} · 完成于 ${fmtTime(finishedAt.value)}` : `${size} · ${segN.value} 线程`
  }
  // 失败行显示翻译过的中文原因（errors.ts）。引擎原话是 `http 403` 这种，
  // 对「只想把游戏下完」的人等于没说；完整原文和建议在右侧详情卡里。
  if (state.value === 'error') return errorLine(props.snap?.error || props.def.error) || '下载失败'
  if (state.value === 'downloading' || state.value === 'preparing') {
    const s = props.snap
    // 引擎重试期间也会填 `error`（例如服务端把响应截断了）。原来这里只显示 ETA，
    // 用户会盯着「下载中 50%」空等，直到它升级成 error 态才知道出事——所以重试
    // 中的错误也要摆出来。同样只摆中文标题，短到放得下这一行。
    const warn = s?.error ? ` · ${errorLine(s.error)}` : ''
    // 校验这段时间速度是 0、剩余时间是空，摆出来就是在撒谎；只说清楚
    // 「字节都在了，正在核对」，免得用户以为下完了又去点暂停。
    if (verifying.value) return `已下完 ${got} · 正在核对校验和`
    // 顺序按「用户此刻最想知道的」排：先速度、再剩余，最后才是已下多少
    // （百分比和进度条已经说了同一件事）。线程数收进详情卡。
    // 没有总长就没有 ETA（算出来必然是 NaN 或 0），这一行改成只报已下多少。
    if (!sizeKnown.value) return `大小未知 · ${fmtSpeed(s?.speed ?? 0)} · 已下 ${got}${warn}`
    return `${fmtSpeed(s?.speed ?? 0)} · 剩余 ${fmtEta(s?.eta ?? 0)} · ${range}${warn}`
  }
  return `${range} · ${segN.value} 线程`
})

const canStart = computed(() => ['queued', 'paused', 'error', 'idle', 'cancelled'].includes(state.value))
const canPause = computed(() => state.value === 'downloading' || state.value === 'preparing')
/**
 * 「打开所在文件夹」任何时候都该能用：半截的 .part 也要能找到、能删。
 * 以前只在 done 才亮，结果失败任务看着一堆 .part 占着磁盘却无从下手。
 */
const canOpen = computed(() => true)
/**
 * 已完成和已失败的行首按钮语义完全不同，这里必须分开：
 *   done  → 重新下载（start 对 done 是空操作，点了没反应像软件坏了）
 *   error → 继续下载。引擎会重读 .part 与 sidecar 从断点续传；
 *           以前失败行给的也是「重新下载」（retry 会删掉断点），
 *           于是一次网卡抖动就把下了 90% 的 8 GB 合集清零重下。
 */
const needsRetry = computed(() => state.value === 'done')
const primaryAction = computed(() => (needsRetry.value ? 'retry' : 'start'))
const primaryTitle = computed(() => {
  if (state.value === 'done') return '重新下载（会清掉现有文件）'
  if (state.value === 'error' || state.value === 'cancelled') return '继续下载（从断点续传）'
  if (state.value === 'paused') return '恢复下载'
  return '开始下载'
})
</script>

<template>
  <div class="task-row" :class="{ selected }" @click="emit('select')">
    <span class="cell-ic" :title="verifyTip">
      <component :is="icon" :class="{ [state]: true }" />
    </span>

    <div class="cell-lead" :title="dir">
      <div class="name">{{ name }}</div>
      <div class="sub">{{ sub }}</div>
    </div>

    <div class="cell-prog">
      <div class="bar">
        <div v-if="indeterminate" class="bar-fill indet" />
        <div
          v-else
          class="bar-fill"
          :class="{ full: pct >= 100 && !verifying, moving: state === 'downloading' }"
          :style="{ width: pct + '%' }"
        />
      </div>
      <span class="pct">{{ pctText }}</span>
    </div>

    <span class="cell-tag">
      <StatusTag :state="state" :badge="badge" />
    </span>

    <span class="cell-actions">
      <button
        v-if="needsRetry"
        class="ibtn"
        title="重新下载（会清掉现有进度）"
        @click.stop="emit('action', 'retry')"
      >
        <ReloadOutlined />
      </button>
      <button v-else class="ibtn" :disabled="!canStart" :title="primaryTitle" @click.stop="emit('action', primaryAction)">
        <CaretRightFilled />
      </button>
      <button class="ibtn" :disabled="!canPause" title="暂停" @click.stop="emit('action', 'pause')">
        <PauseOutlined />
      </button>
      <button class="ibtn" :disabled="!canOpen" title="打开所在文件夹" @click.stop="emit('action', 'open')">
        <FolderOpenOutlined />
      </button>
      <button class="ibtn danger" title="移除任务（可选连文件一起删）" @click.stop="emit('action', 'remove')">
        <DeleteOutlined />
      </button>
    </span>
  </div>
</template>

<style scoped>
.task-row {
  display: flex;
  align-items: center;
  gap: var(--col-gap);
  min-height: 52px;
  padding: 8px 10px;
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
  width: var(--col-ic);
  text-align: center;
  color: var(--ant-color-text-quaternary);
  font-size: 16px;
}
.cell-ic .downloading,
.cell-ic .preparing { color: var(--ant-color-primary); }
.cell-ic .done { color: var(--ant-color-success); }
.cell-ic .error { color: var(--ant-color-error); }

/* 唯一会变宽的列：长文件名靠省略号收，不把右侧列挤出去 */
.cell-lead {
  flex: 1;
  min-width: 0;
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

.cell-prog {
  flex: none;
  width: var(--col-prog);
  display: flex;
  align-items: center;
  gap: 8px;
}
/* 自绘进度条：antd 的 Progress 在小尺寸下对比度偏低，且列表里几十行同时跑
   transition 会掉帧，这里直接画 —— 颜色完全走 token，深浅色自动切换 */
.bar {
  flex: 1;
  min-width: 0;
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
.bar-fill.full {
  background: var(--ant-color-success);
}
/* 不定量：服务器没报长度时没有任何百分比可说。停在 0% 看起来像「根本没开始下」，
   用户下一步就是点暂停；一条自己走的短条纹才表示「确实在传」。
   只动 transform，宽度仍是定值，列宽不受影响。 */
.bar-fill.indet {
  width: 35%;
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
.pct {
  flex: none;
  width: 44px;
  text-align: right;
  font-size: 12px;
  font-family: var(--ant-font-family-code);
  color: var(--ant-color-text-secondary);
}

.cell-tag {
  flex: none;
  width: var(--col-tag);
  display: flex;
  justify-content: center;
}

.cell-actions {
  flex: none;
  width: var(--col-act);
  display: flex;
  justify-content: flex-end;
  gap: 2px;
}
.ibtn {
  width: 26px;
  height: 26px;
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

/* 窄面板（最小窗口时列表只有 ~490px）：状态徽标让位给名称。
   状态本身还有行首图标颜色和副标题兜底，不会变成不可知。 */
@container fdlist (max-width: 560px) {
  .cell-tag {
    display: none;
  }
}
</style>
