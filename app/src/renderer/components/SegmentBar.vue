<script setup lang="ts">
/**
 * 分段进度带。多线程下载的可视化核心：每个分片独立一格、各自填自己的进度，
 * 直接能看出哪几段快、哪几段慢——这就是 IDM 的"分段"感。
 *
 * 用 div 直接画，不引图表库。布局消费 :root 的 --ant-* 变量跟随主题。
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    values: number[]
    height?: number
  }>(),
  { height: 18 },
)

/** 引擎可能发空数组（preparing 阶段），退化成 1 格避免布局塌掉。 */
const cells = computed(() => {
  const v = props.values.length ? props.values : [0]
  return v.map((x) => Math.max(0, Math.min(1, Number(x) || 0)))
})
</script>

<template>
  <div class="segbar" :style="{ height: height + 'px' }">
    <div
      v-for="(v, i) in cells"
      :key="i"
      class="seg-cell"
      :style="{ background: 'var(--ant-color-fill-quaternary)' }"
    >
      <div
        v-if="v > 0"
        class="seg-fill"
        :style="{
          width: Math.max(v * 100, 12) + '%',
          background: v >= 1 ? 'var(--ant-color-primary)' : 'var(--ant-color-primary-bg-hover)',
        }"
      />
    </div>
  </div>
</template>

<style scoped>
.segbar {
  display: flex;
  gap: 2px;
  width: 100%;
}
.seg-cell {
  flex: 1;
  position: relative;
  overflow: hidden;
  border-radius: 3px;
}
.seg-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.12s linear;
}
</style>
