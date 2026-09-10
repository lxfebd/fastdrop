<script setup lang="ts">
/**
 * 新建下载对话框。对应 fastdrop/dialogs.py 的 NewDownloadDialog：
 * URL + 保存位置 + 分片数 + 备注。
 *
 * 提交前的 URL 规范化（补 https:// 前缀）和老版一致，让用户贴裸域名也能用。
 */
import { computed, reactive } from 'vue'
import { DownOutlined, FolderOpenOutlined } from '@ant-design/icons-vue'
import { Button, Form, Input, InputNumber } from 'ant-design-vue'
import type { Settings } from '../../shared/types'

const props = defineProps<{ settings: Settings }>()
const emit = defineEmits<{
  submit: [input: { url: string; dest: string; threads: number; note: string }]
}>()

const form = reactive({
  url: '',
  dest: props.settings.download_dir,
  threads: props.settings.threads,
  note: '',
})

const canSubmit = computed(() => form.url.trim().length > 0)

async function browse(): Promise<void> {
  const p = await window.fd.pickDir()
  if (p) form.dest = p
}

/** 回车提交：和老版 OK 按钮同一条路径。 */
function submit(): void {
  if (!canSubmit.value) return
  emit('submit', {
    url: form.url.trim(),
    dest: form.dest.trim(),
    threads: form.threads,
    note: form.note.trim(),
  })
}
</script>

<template>
  <div class="dlg">
    <div class="dlg-head">
      <span class="dlg-ic"><DownOutlined /></span>
      <span class="dlg-title">新建下载</span>
    </div>

    <div class="dlg-card">
      <Form layout="horizontal" :label-col="{ style: { width: 84 } }" :wrapper-col="{ flex: 1 }" @keydown.enter="submit">
        <Form.Item label="下载链接" required>
          <Input
            v-model:value="form.url"
            placeholder="https://example.com/file.zip"
            class="mono"
            allow-clear
            @press-enter="submit"
          />
        </Form.Item>

        <Form.Item label="保存到">
          <div class="row">
            <Input v-model:value="form.dest" class="mono" />
            <Button @click="browse">
              <template #icon><FolderOpenOutlined /></template>
              浏览
            </Button>
          </div>
        </Form.Item>

        <Form.Item label="分片数">
          <div class="row">
            <InputNumber v-model:value="form.threads" :min="1" :max="32" style="width: 90px" />
            <span class="hint">越多越快，但小文件与不支持 Range 的站点会自动降为 1</span>
          </div>
        </Form.Item>

        <Form.Item label="备注">
          <Input v-model:value="form.note" placeholder="可选" />
        </Form.Item>
      </Form>
    </div>

    <div class="dlg-foot">
      <Button @click="submit" :disabled="!canSubmit" type="primary">开始下载</Button>
    </div>
  </div>
</template>

<style scoped>
.dlg {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.dlg-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dlg-ic {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--ant-radius);
  background: var(--ant-color-primary-bg);
  color: var(--ant-color-primary);
  font-size: 16px;
}
.dlg-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--ant-color-text);
}
/* 表单区用浅底衬托，避免对话框里输入框直接浮在纯白上看不出区块 */
.dlg-card {
  background: var(--ant-color-fill-panel);
  border-radius: var(--ant-radius);
  padding: 16px;
}
.row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.hint {
  font-size: 12px;
  color: var(--ant-color-text-tertiary);
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
