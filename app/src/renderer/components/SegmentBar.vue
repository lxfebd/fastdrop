<script setup lang="ts">
/**
 * 分段进度带。多线程下载的可视化核心：每个分片独立一格、各自填自己的进度，
 * 直接能看出哪几段快、哪几段慢——这就是 IDM 的"分段"感。
 *
 * 用 div 直接画，不引图表库。布局消费 :root 的 --ant-* 变量跟随主题。
 *
 * 颜色约定（这个组件的坑就在这里，改之前看一下）：
 *   未开始 = fill-quaternary  极淡灰，表示「这段还没动」
 *   进行中 = primary 半透明    能看出有内容在流，但不抢已完成格的视线
 *   已完成 = primary 实色      最终态最实，一眼能数出完成了几段
 * 初版用 primary-bg-hover（透明度 0.14）做「进行中」，白底上几乎看不见，
 * 等于把最核心的视觉做成了隐形——那是初版观感差的一大半原因。
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    values: number[]
    height?: number
  }>(),
  { height: 20 },
)

/** 引擎可能发空数组（preparing 阶段），退化成 1 格避免布局塌掉。 */
const cells = computed(() => {
  const v = props.values.length ? props.values : [0]
  return v.map((x) => Math.max(0, Math.min(1, Number(x) || 0)))
})

const doneCount = computed(() => props.values.filter((v) => v >= 1).length)
const trackHeight = computed(() => props.height + 'px')

/** 进度 0 但非负时不渲染填充；给个最小可见宽度让刚起动的分片不至于完全看不见。 */
function pct(v: number): string {
  return v >= 1 ? '100%' : Math.max(v * 100, 6) + '%'
}
</script>

<template>
  <div class="segbar">
    <div
      v-for="(v, i) in cells"
      :key="i"
      class="seg-cell"
      :style="{ height: trackHeight }"
      :title="`分片 ${i + 1} · ${Math.round(v * 100)}%`"
    >
      <div v-if="v > 0" class="seg-fill" :class="{ done: v >= 1 }" :style="{ width: pct(v) }" />
    </div>
    <span v-if="values.length > 1" class="seg-sum">{{ doneCount }}/{{ cells.length }} 段完成</span>
  </div>
</template>

<style scoped>
.segbar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}
.seg-cell {
  position: relative;
  overflow: hidden;
  border-radius: 3px;
  /* 分段带嵌在 fill-panel 区块里，轨道必须比区块更深一档才看得出，
     所以用 fill-bar 而不是 fill-quaternary */
  background: var(--ant-color-fill-bar);
}
.seg-fill {
  height: 100%;
  border-radius: 3px;
  background: color-mix(in srgb, var(--ant-color-primary) 55%, var(--ant-color-bg-container));
  /* 对齐引擎 100ms 的推送周期，和 TaskRow 的 .bar-fill 保持一致 */
  transition: width 0.1s linear;
}
.seg-fill.done {
  background: var(--ant-color-primary);
}
.seg-sum {
  font-size: 12px;
  color: var(--ant-color-text-tertiary);
  font-family: var(--ant-font-family-code);
  text-align: right;
}
</style>
