<script setup lang="ts">
/**
 * 左侧软上下文框架：品牌、新建按钮、按状态过滤的导航、底部设置/关于。
 * 对应 fastdrop/ui_main.py 的 Sidebar，宽度同样固定 228。
 */
import { computed, type Component } from 'vue'
import {
  CaretRightFilled,
  CheckCircleOutlined,
  CloseCircleOutlined,
  DownOutlined,
  HomeOutlined,
  PauseOutlined,
  PlusOutlined,
  QuestionCircleOutlined,
  SettingOutlined,
} from '@ant-design/icons-vue'
import { Button } from 'ant-design-vue'
import type { TaskRow } from '../../shared/types'
import { matchesFilter } from '../status'

const props = defineProps<{ rows: TaskRow[]; filter: string }>()
const emit = defineEmits<{ nav: [key: string] }>()

interface NavDef {
  key: string
  text: string
  icon: Component
}

const NAVS: NavDef[] = [
  { key: 'all', text: '全部任务', icon: HomeOutlined },
  { key: 'downloading', text: '下载中', icon: CaretRightFilled },
  { key: 'paused', text: '已暂停', icon: PauseOutlined },
  { key: 'done', text: '已完成', icon: CheckCircleOutlined },
  { key: 'error', text: '失败', icon: CloseCircleOutlined },
]

/** 每个过滤桶的行数。「下载中」桶同时收 preparing，和列表匹配规则一致。 */
const counts = computed(() =>
  NAVS.map((n) => ({
    ...n,
    count: props.rows.filter((r) => matchesFilter(r.snap?.state, n.key)).length,
  })),
)
</script>

<template>
  <aside class="sidebar">
    <div class="brand">
      <span class="logo">
        <DownOutlined />
      </span>
      <span class="brand-name">FastDrop</span>
    </div>

    <Button type="primary" block class="add-btn" @click="emit('nav', 'add')">
      <template #icon><PlusOutlined /></template>
      新建下载
    </Button>

    <div class="nav-label">下载</div>

    <nav class="nav">
      <button
        v-for="n in counts"
        :key="n.key"
        class="nav-row"
        :class="{ active: filter === n.key }"
        @click="emit('nav', n.key)"
      >
        <component :is="n.icon" class="nav-ic" />
        <span class="nav-text">{{ n.text }}</span>
        <span v-if="n.count > 0" class="nav-count">{{ n.count }}</span>
      </button>
    </nav>

    <div class="spacer" />

    <div class="foot">
      <button class="foot-btn" title="偏好设置" @click="emit('nav', 'settings')">
        <SettingOutlined />
      </button>
      <button class="foot-btn" title="关于 FastDrop" @click="emit('nav', 'about')">
        <QuestionCircleOutlined />
      </button>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  flex: none;
  width: 228px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px 10px 12px;
  background: var(--ant-color-bg-layout);
  border-right: 1px solid var(--ant-color-border-secondary);
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 2px;
}
.logo {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  background: var(--ant-color-primary);
  color: var(--ant-color-primary-text);
  font-size: 15px;
}
.brand-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--ant-color-text);
}
.add-btn {
  border-radius: 8px;
}
.nav-label {
  font-size: 11px;
  color: var(--ant-color-text-tertiary);
  padding: 0 8px;
  letter-spacing: 0.02em;
}
.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.nav-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--ant-color-text-secondary);
  font-size: 13px;
  cursor: pointer;
  text-align: left;
}
.nav-row:hover {
  background: var(--ant-color-fill-quaternary);
  color: var(--ant-color-text);
}
.nav-row.active {
  background: var(--ant-color-primary-bg);
  color: var(--ant-color-primary);
}
.nav-ic {
  flex: none;
  width: 16px;
  text-align: center;
  font-size: 13px;
}
.nav-text {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.nav-count {
  flex: none;
  font-size: 11px;
  font-family: var(--ant-font-family-code);
  color: var(--ant-color-text-tertiary);
}
.nav-row.active .nav-count {
  color: var(--ant-color-primary);
}
.spacer {
  flex: 1;
}
.foot {
  display: flex;
  gap: 6px;
}
.foot-btn {
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--ant-color-text-tertiary);
  cursor: pointer;
  font-size: 15px;
  padding: 0;
}
.foot-btn:hover {
  background: var(--ant-color-fill-tertiary);
  color: var(--ant-color-text);
}
</style>
