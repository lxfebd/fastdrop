<script setup lang="ts">
/**
 * 任务状态徽标。用 ant Tag 的 preset 色
 * 而不是硬编码十六进制，这样深/浅色切换由 ConfigProvider 统一负责。
 *
 * badge 是可选的显示覆盖（校验中、大小未知这类「同一个 state 下的不同处境」）。
 * 文案一律由 status.ts 的 statusBadge() 给出，模板里不自己拼字符串。
 */
import { Tag } from 'ant-design-vue'
import { computed } from 'vue'
import type { TaskState } from '../../shared/types'
import { statusMeta, type StatusBadge } from '../status'

const props = defineProps<{ state: TaskState; badge?: StatusBadge | null }>()

const meta = computed(() => props.badge ?? statusMeta(props.state))
</script>

<template>
  <Tag :color="meta.tone" class="status-tag">{{ meta.label }}</Tag>
</template>

<style scoped>
.status-tag {
  font-size: 12px;
  line-height: 18px;
  padding: 0 8px;
}
</style>
