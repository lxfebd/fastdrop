<script setup lang="ts">
/**
 * 新建下载对话框：
 * URL + 保存位置 + 分片数 + 校验和 + 备注。
 *
 * 提交前的 URL 规范化（补 https:// 前缀）让用户贴裸域名也能用。
 */
import { computed, reactive } from 'vue'
import { DownOutlined, FolderOpenOutlined } from '@ant-design/icons-vue'
import { Button, Form, Input, InputNumber } from 'ant-design-vue'
import type { Settings } from '../../shared/types'
import { normalizeChecksum } from '../../shared/types'

const props = defineProps<{ settings: Settings }>()
const emit = defineEmits<{
  submit: [input: { url: string; dest: string; threads: number; note: string; checksum: string }]
}>()

const form = reactive({
  url: '',
  dest: props.settings.download_dir,
  threads: props.settings.threads,
  note: '',
  checksum: '',
})

/**
 * 校验和当场判，不等主进程回错误：一串读不懂的东西存进任务，代价是十几个 GB
 * 下完才报「校验失败」，那时用户已经不知道差异出在哪。主进程那道拒绝是
 * 最后一道保险，不是给用户看的提示。文案和 normalizeChecksum 认的形状一致。
 */
const checksumError = computed(() =>
  normalizeChecksum(form.checksum) === null
    ? '读不懂这串校验和：需要 32 位（MD5）、40 位（SHA-1）或 64 位（SHA-256）十六进制，也可以写成 sha256:… 的形式'
    : '',
)

const canSubmit = computed(() => form.url.trim().length > 0 && !checksumError.value)

async function browse(): Promise<void> {
  const p = await window.fd.pickDir()
  if (p) form.dest = p
}

/**
 * 同一次回车会经过两条路径——URL 输入框的 press-enter 先触发，keydown 冒泡到
 * Form 上的 keydown.enter 再触发一次。两条监听拿到的是同一个原生事件对象，
 * 用它做去重键，既不会提交两遍也不会把对话框卡死在「已提交」状态。
 */
let lastKeydown: Event | null = null

function submit(e?: Event): void {
  if (e && e === lastKeydown) return
  lastKeydown = e ?? null
  if (!canSubmit.value) return
  emit('submit', {
    url: form.url.trim(),
    dest: form.dest.trim(),
    // InputNumber 被清空时给出 null，不能让它流进主进程当线程数
    threads: form.threads || props.settings.threads,
    note: form.note.trim(),
    // 发规范化后的形状；留空即空串 = 不校验，不假造任何占位值
    checksum: normalizeChecksum(form.checksum) ?? '',
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

        <Form.Item label="校验和" :validate-status="checksumError ? 'error' : ''">
          <div class="cs-wrap">
            <Input
              v-model:value="form.checksum"
              placeholder="可选：粘贴站点给的 md5 / sha1 / sha256"
              class="mono"
              allow-clear
            />
            <!-- 表单内提示：读不懂的校验和会挡住提交，所以这行不是说明文字而已 -->
            <span v-if="checksumError" class="cs-error">{{ checksumError }}</span>
            <span v-else class="hint">留空 = 不校验。只贴十六进制串也能认，按长度判断算法。</span>
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
/* 校验和这一格要同时摆输入框和一句说明，纵向排；说明换行也不影响上面的输入框宽度 */
.cs-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: stretch;
}
.cs-error {
  font-size: 12px;
  line-height: 1.6;
  color: var(--ant-color-error);
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
