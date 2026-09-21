// FastDrop 下载助手 — 后台 service worker。
//
// 职责：把「下载链接」变成一条 native messaging 消息，交给 FastDrop 宿主
// （com.fastdrop.host）。宿主是 FastDrop.exe 自己：没开就自动拉起，开了就把
// 链接投进收件箱。用户全程不用复制链接。
//
// MV3 限制：service worker 会被回收，不能依赖全局状态；bindings 都要在
// chrome.* API 的回调里临时取。右键菜单的创建要在 install/startup 都做一次，
// 因为回收后菜单不保证还在。

const HOST_NAME = 'com.fastdrop.host'
const MENU_ID = 'fastdrop-download'

// 右键菜单：链接上给「用 FastDrop 下载」，页面上给「下载本页」。
function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ID, title: '用 FastDrop 下载', contexts: ['link'] })
    chrome.contextMenus.create({ id: 'fastdrop-download-page', title: '用 FastDrop 下载本页', contexts: ['page'] })
    chrome.contextMenus.create({ id: MENU_ID, title: '用 FastDrop 下载', contexts: ['audio', 'video'] })
  })
}

chrome.runtime.onInstalled.addListener(createMenus)
chrome.runtime.onStartup.addListener(createMenus)

// 把下载链接交给宿主。
// 三种结局：ok（已在 FastDrop 列表里）、宿主没响应（FastDrop 没开/没注册，
// 给用户可操作提示）、宿主明确拒收（把原因原样转发）。
function sendToFastDrop(url) {
  try {
    chrome.runtime.sendNativeMessage(HOST_NAME, { type: 'add-task', url, note: '' }, (response) => {
      if (chrome.runtime.lastError) {
        // 宿主没注册 = FastDrop 从没开过（首次安装需要 FastDrop 自己写注册表）。
        const msg = chrome.runtime.lastError.message || ''
        notify(`FastDrop 没响应：${msg}。请先打开一次 FastDrop 完成注册`, url)
        return
      }
      if (response && response.ok) {
        notify('已加入 FastDrop 下载列表', url)
        return
      }
      const err = (response && typeof response.error === 'string' && response.error) || '未知错误'
      notify(`FastDrop 拒收：${err}`, url)
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    notify(`调用 FastDrop 宿主失败：${msg}`, url)
  }
}

function notify(title, url) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message: url.length > 120 ? `${url.slice(0, 120)}…` : url,
  })
}

chrome.contextMenus.onClicked.addListener((info) => {
  const url = info.linkUrl || info.srcUrl || info.pageUrl
  if (!url || !/^(https?|ftp):\/\//i.test(url)) return
  sendToFastDrop(url)
})

// 点击扩展图标也打开 popup（manifest 已配 default_popup），这里兜底处理
// 不弹 popup 的浏览器/场景：把当前页交给 FastDrop。
chrome.action?.onClicked?.addListener?.((tab) => {
  if (tab && tab.url && /^(https?|ftp):\/\//i.test(tab.url)) sendToFastDrop(tab.url)
})