import { createApp } from 'vue'
import App from './App.vue'
import 'ant-design-vue/dist/reset.css'

/**
 * 首屏出问题时替主进程补一句原因。
 *
 * 白屏时用户手上没有任何信息，主进程那边也只看得见「等不到挂载」这一件事；
 * 真正的错因只有这里知道。桥本身坏掉（preload 没挂上，window.fd 就是 undefined）
 * 时什么都发不出去，那也不要紧——兜底页靠看门狗超时，不依赖这一次上报。
 */
function reportBoot(detail: string): void {
  try {
    window.fd?.uiBoot?.error(detail)
  } catch {
    // 连发都发不出去，已经没有能说话的地方
  }
}

try {
  createApp(App).mount('#app')
  window.fd?.uiBoot?.ready()
} catch (e) {
  const detail = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e)
  reportBoot(detail)
  console.error('FastDrop 界面启动失败：', e)
}
