<script setup lang="ts">
/**
 * 偏好设置：下载 / 通知 / 网络 / 外观四个页签。
 *
 * AntDV 的 Tabs 没有 React 版的 items 配置，页签必须写成 <TabPane> 子组件；
 * 页签标题用 tab 属性（不是 label），内容放默认插槽。
 *
 * save() 必须逐个字段列出来（而不是 {...form}）：Settings 加了字段时这里
 * 漏一个，主进程会把它回落到默认值，用户会发现「勾了没保存」。
 */
import { computed, reactive } from 'vue'
import { FolderOpenOutlined } from '@ant-design/icons-vue'
import { Button, Checkbox, Form, Input, InputNumber, Switch, TabPane, Tabs } from 'ant-design-vue'
import type { Settings } from '../../shared/types'
import { proxyFormatError } from '../../shared/proxy'

const props = defineProps<{ settings: Settings }>()
const emit = defineEmits<{ save: [s: Settings] }>()

const form = reactive<Settings>({ ...props.settings })

/** 代理形状的校验与主进程同源（shared/proxy），免得出现「界面放行、主进程拒绝」。 */
const proxyError = computed(() => proxyFormatError(form.proxy))

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
    notify_on_finish: form.notify_on_finish,
    notify_on_error: form.notify_on_error,
    close_to_tray: form.close_to_tray,
    keep_awake: form.keep_awake,
    // 输入框允许清空（value 变 null），空/负数一律按「不限速」发出去，
    // 免得主进程把 NaN 回落成 0 之后，界面上还留着一个看不清的数字。
    rate_limit_kbps:
      Number.isFinite(form.rate_limit_kbps) && form.rate_limit_kbps > 0
        ? Math.floor(form.rate_limit_kbps)
        : 0,
    auto_update_check: form.auto_update_check,
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
            <Form.Item label=" " :colon="false">
              <Checkbox v-model:checked="form.close_to_tray">
                关闭主窗口时缩到托盘（后台继续下载）
              </Checkbox>
            </Form.Item>
            <Form.Item label=" " :colon="false">
              <Checkbox v-model:checked="form.keep_awake">
                有任务在跑时阻止电脑休眠
              </Checkbox>
            </Form.Item>
            <Form.Item label=" " :colon="false">
              <Checkbox v-model:checked="form.auto_update_check">
                启动时自动检查应用更新
              </Checkbox>
            </Form.Item>
          </Form>
        </div>
      </TabPane>
      <!-- 通知单独一页：这两条决定「人不在窗口前也知道下完了」，
           是挂机下载最常被问到的开关，藏在下载页的一堆数字里不好找。 -->
      <TabPane key="notify" tab="通知">
        <div class="card">
          <Form layout="horizontal" :label-col="{ style: { width: 120 } }" :wrapper-col="{ flex: 1 }">
            <Form.Item label=" " :colon="false">
              <Checkbox v-model:checked="form.notify_on_finish">下载完成时弹系统通知</Checkbox>
            </Form.Item>
            <Form.Item label=" " :colon="false">
              <Checkbox v-model:checked="form.notify_on_error">下载失败时弹系统通知</Checkbox>
            </Form.Item>
            <Form.Item label=" " :colon="false">
              <span class="hint">
                通知只在窗口失去焦点时弹（窗口就在面前还弹通知是骚扰）。点通知会跳回并选中那条任务。
              </span>
            </Form.Item>
          </Form>
        </div>
      </TabPane>
      <TabPane key="net" tab="网络">
        <div class="card">
          <Form layout="horizontal" :label-col="{ style: { width: 120 } }" :wrapper-col="{ flex: 1 }">
            <Form.Item label="代理">
              <Input
                v-model:value="form.proxy"
                placeholder="留空＝跟随系统代理"
                :status="proxyError ? 'error' : undefined"
                class="mono"
                allow-clear
              />
              <span v-if="proxyError" class="hint hint-err">{{ proxyError }}</span>
            </Form.Item>
            <Form.Item label=" " :colon="false">
              <span class="hint">
                代理对下载、游戏页内置浏览器、站点解析同时生效。填 http://127.0.0.1:7890
                或 socks5://127.0.0.1:7891 这种形式；留空则跟随系统代理（含 PAC 自动配置）。
              </span>
            </Form.Item>
            <Form.Item label="User-Agent">
              <Input v-model:value="form.user_agent" placeholder="留空使用内置 UA" class="mono" />
            </Form.Item>
            <Form.Item label="限速">
              <div class="row">
                <InputNumber
                  v-model:value="form.rate_limit_kbps"
                  :min="0"
                  :max="104857600"
                  :step="128"
                  style="width: 150px"
                />
                <span class="lbl">KiB/s</span>
              </div>
            </Form.Item>
            <Form.Item label=" " :colon="false">
              <span class="hint">
                0 = 不限速。每个下载任务各拿一份额度，1 MiB/s 填 1024。
                改完点保存就立刻生效，正在跑的任务不用重下。
              </span>
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
/* 说明性小字：跟着开关走，解释「什么时候会弹」这种不看代码猜不到的行为 */
.hint {
  font-size: 12px;
  line-height: 1.7;
  color: var(--ant-color-text-tertiary);
}
/* 校验不通过的说明要独占一行并用错误色：它跟在输入框后面，混在灰色小字里看不出是自己填错了 */
.hint-err {
  display: block;
  color: var(--ant-color-error);
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
