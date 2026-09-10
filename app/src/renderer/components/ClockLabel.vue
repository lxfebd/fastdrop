<script setup lang="ts">
/**
 * 状态栏右下角的时间。独立成一个组件，是为了把它每秒一次的
 * tick 圈死在这个节点里——放在 AppShell 顶层组件里的话，每秒那一次
 * ref 变更会带动整个 AppShell 重新求值模板，纯浪费。
 *
 * 格式固定为 `YYYY-MM-DD  HH:MM:SS`（秒位前两个空格，便于肉眼对齐）。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'

const text = ref('')
let timer: ReturnType<typeof setInterval> | null = null

function tick(): void {
  const d = new Date()
  const pad = (x: number) => String(x).padStart(2, '0')
  text.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}  ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

onMounted(() => {
  tick()
  timer = setInterval(tick, 1000)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <span>{{ text }}</span>
</template>
