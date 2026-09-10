<script setup lang="ts">
/**
 * 偏好设置。对应 fastdrop/dialogs.py 的 SettingsDialog：下载 / 网络 / 外观三个页签。
 *
 * AntDV 的 Tabs 没有 React 版的 items 配置，页签必须写成 <TabPane> 子组件；
 * 页签标题用 tab 属性（不是 label），内容放默认插槽。
 */
import { reactive } from 'vue'
import { FolderOpenOutlined } from '@ant-design/icons-vue'
import { Button, Checkbox, Form, Input, InputNumber, Switch, TabPane, Tabs } from 'ant-design-vue'
import type { Settings } from '../../shared/types'

const props = defineProps<{ settings: Settings }>()
const emit = defineEmits<{ save: [s: Settings] }>()

const form = reactive<Settings>({ ...props.settings })

async function browseDir(): Promise<void> {
  const p = await window.fd.pickDir()
  if (p) form.download_dir = p
}

function save(): void {
  emit('save', {
    threads: form.threads,
    max_concurrent: form.max_concurrent,
    download_dir: form.download_dir.trim(),
    proxy: form.proxy.trim(),
    user_agent: form.user_agent.trim(),
    confirm_delete: form.confirm_delete,
    dark: form.dark,
  })
}
</script>

<template>
  <div class="dlg">
    <div class="dlg-head">
      <span class="dlg-title">偏好设置</span>
    </div>

    <Tabs defaultActiveKey="download">
      <TabPane key="download" tab="下载">
        <div class="card">
          <Form layout="horizontal" :label-col="{ style: { width: 120 } }" :wrapper-col="{ flex: 1 }">
            <Form.Item label="默认分片数">
              <InputNumber v-model:value="form.threads" :min="1" :max="32" style="width: 110px" />
            </Form.Item>
            <Form.Item label="同时下载任务数">
              <InputNumber v-model:value="form.max_concurrent" :min="1" :max="20" style="width: 110px" />
            </Form.Item>
            <Form.Item label="默认保存目录">
              <div class="row">
                <Input v-model:value="form.download_dir" class="mono" />
                <Button @click="browseDir">
                  <template #icon><FolderOpenOutlined /></template>
                  浏览
                </Button>
              </div>
            </Form.Item>
            <Form.Item label=" " :colon="false">
              <Checkbox v-model:checked="form.confirm_delete">删除任务时确认</Checkbox>
            </Form.Item>
          </Form>
        </div>
      </TabPane>
      <TabPane key="net" tab="网络">
        <div class="card">
          <Form layout="horizontal" :label-col="{ style: { width: 120 } }" :wrapper-col="{ flex: 1 }">
            <Form.Item label="HTTP 代理">
              <Input v-model:value="form.proxy" placeholder="http://127.0.0.1:7890" class="mono" />
            </Form.Item>
            <Form.Item label="User-Agent">
              <Input v-model:value="form.user_agent" placeholder="留空使用内置 UA" class="mono" />
            </Form.Item>
          </Form>
        </div>
      </TabPane>
      <TabPane key="ui" tab="外观">
        <div class="card">
          <div class="row-between">
            <span class="lbl">深色模式</span>
            <Switch v-model:checked="form.dark" />
          </div>
        </div>
      </TabPane>
    </Tabs>

    <div class="dlg-foot">
      <Button type="primary" @click="save">保存</Button>
    </div>
  </div>
</template>

<style scoped>
.dlg {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.dlg-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--ant-color-text);
}
/* 表单区用浅底衬托，和 NewDownloadDialog 保持一致 */
.card {
  background: var(--ant-color-fill-panel);
  border-radius: var(--ant-radius);
  padding: 16px;
}
.row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.row-between {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.lbl {
  font-size: 14px;
  color: var(--ant-color-text);
}
.mono {
  font-family: var(--ant-font-family-code);
}
.dlg-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
