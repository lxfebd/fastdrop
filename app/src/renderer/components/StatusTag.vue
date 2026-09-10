<script setup lang="ts">
/**
 * 任务状态徽标。用 ant Tag 的 preset 色
 * 而不是硬编码十六进制，这样深/浅色切换由 ConfigProvider 统一负责。
 */
import { Tag } from 'ant-design-vue'
import { computed } from 'vue'
import type { TaskState } from '../../shared/types'
import { statusMeta } from '../status'

const props = defineProps<{ state: TaskState }>()

const meta = computed(() => statusMeta(props.state))
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
