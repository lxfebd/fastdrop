<script setup lang="ts">
/**
 * 根组件。ant-design-vue 的 ConfigProvider + theme 算法负责整套配色，
 * 不需要把设计 token 手工翻译成样式字符串。
 *
 * 一份调色板同时喂两个消费方：ConfigProvider 拿到 seed token 生成组件样式，
 * applyPaletteCss 把同一批颜色写成 :root 变量供布局自己的 CSS 使用。
 * 只给一个消费方的话，另一侧的颜色就会漂。
 */
import { computed, onMounted, watch } from 'vue'
import { ConfigProvider } from 'ant-design-vue'
import zhCN from 'ant-design-vue/es/locale/zh_CN'
import { appTheme, applyPaletteCss } from '@/renderer/theme'
import AppShell from '@/renderer/components/AppShell.vue'
import { useAppStore } from '@/renderer/store'

const store = useAppStore()
const { state } = store

onMounted(() => {
  store.init()
})

const isDark = computed(() => state.settings?.dark ?? false)
const cfg = computed(() => appTheme(isDark.value))

watch(
  isDark,
  () => applyPaletteCss(isDark.value),
  { immediate: true },
)
</script>

<template>
  <ConfigProvider :locale="zhCN" :theme="cfg">
    <AppShell v-if="state.ready" />
  </ConfigProvider>
</template>
