// FastDrop 下载助手 — popup。
const HOST_NAME = 'com.fastdrop.host'
const statusEl = document.getElementById('status')

function setStatus(text, cls) {
  statusEl.textContent = text
  statusEl.className = `status ${cls || ''}`
}

document.getElementById('sendCurrent').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const url = tab && tab.url
  if (!url || !/^(https?|ftp):\/\//i.test(url)) {
    setStatus('当前页没有可下载的链接', 'bad')
    return
  }
  setStatus('正在交给 FastDrop…')
  try {
    const response = await chrome.runtime.sendNativeMessage(HOST_NAME, { type: 'add-task', url, note: '' })
    if (response && response.ok) setStatus('已加入 FastDrop 下载列表', 'ok')
    else setStatus(`FastDrop 拒收：${(response && response.error) || '未知错误'}`, 'bad')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    setStatus(`FastDrop 没响应：${msg}。请先打开一次 FastDrop 完成注册`, 'bad')
  }
})