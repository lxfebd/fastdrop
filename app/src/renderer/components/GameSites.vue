/**
 * 游戏站页签：内嵌浏览器 + 搜索聚合 + 直链捕获。
 *
 * 左侧是站点列表与聚合搜索结果，右侧是 webview（partition=persist:gamesites，
 * 登录状态跨重启保持）。页面里点下载时，主进程捕获桥通过
 * push:download-captured 把真实文件 URL 推过来，这里弹确认后调 sitesAddTask。
 *
 * webview 是 Electron 的 OOPIF，有自己的进程与会话；它在沙箱化渲染进程里
 * 也能用（webviewTag: true 在主进程开）。注意：webview 的 DOM 事件需要
 * 在元素上直接挂监听，不能用 Vue 的 @事件语法（部分事件不冒泡）。
 */
<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  CompassOutlined,
  DownloadOutlined,
  LinkOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons-vue'
import type {
  Mirror,
  SiteInfo,
  SiteMirrorOutcome,
  SiteSearchOutcome,
  SiteSearchResult,
} from '../../shared/sites'
import type { CapturedDownload } from '../../shared/ipc'
import type { WebviewElement } from '../webview'

const sites = ref<SiteInfo[]>([])
const activeSiteId = ref<string>('gamer520')

const searchKeyword = ref('')
const searching = ref(false)
const searchDone = ref(false)
/** 每个站一列结果，聚合展示 */
const resultsBySite = ref<Array<{ site: SiteInfo; outcome: SiteSearchOutcome }>>([])

const webviewEl = ref<WebviewElement | null>(null)
const address = ref('')
const canBack = ref(false)
const canForward = ref(false)
const loading = ref(false)
const pageTitle = ref('')

// --------------------------------------------------------------- 站点与导航

onMounted(async () => {
  try {
    sites.value = await window.fd.sitesList()
    if (sites.value.length) {
      activeSiteId.value = sites.value[0]?.id ?? 'gamer520'
    }
  } catch {
    // 主进程未就绪
  }
  await nextTick()
  bindWebview()
})

function activeSite(): SiteInfo {
  return sites.value.find((s) => s.id === activeSiteId.value) ?? {
    id: 'gamer520',
    name: 'Gamer520',
    home: 'https://www.gamer520.com',
    searchPlaceholder: '搜索游戏…',
  }
}

function switchSite(id: string): void {
  activeSiteId.value = id
  searchDone.value = false
  searchKeyword.value = ''
  resultsBySite.value = []
  const home = activeSite().home
  webviewEl.value?.loadURL(home)
  address.value = home
}

function nav(url: string): void {
  webviewEl.value?.loadURL(url)
  address.value = url
}

async function bindWebview(): Promise<void> {
  const wv = webviewEl.value
  if (!wv) return
  wv.addEventListener('did-navigate', (e) => {
    address.value = e.url
    void refreshNavState()
  })
  wv.addEventListener('did-navigate-in-page', (e) => {
    if (e.isMainFrame) {
      address.value = e.url
      void refreshNavState()
    }
  })
  wv.addEventListener('did-start-loading', () => {
    loading.value = true
  })
  wv.addEventListener('did-stop-loading', () => {
    loading.value = false
    void refreshNavState()
  })
  wv.addEventListener('page-title-updated', (e) => {
    pageTitle.value = e.title
  })
}

async function refreshNavState(): Promise<void> {
  const wv = webviewEl.value
  if (!wv) return
  try {
    canBack.value = wv.canGoBack()
    canForward.value = wv.canGoForward()
  } catch {
    // webview 未就绪
  }
}

function goBack(): void {
  webviewEl.value?.goBack()
}
function goForward(): void {
  webviewEl.value?.goForward()
}
function goHome(): void {
  nav(activeSite().home)
}
function reload(): void {
  webviewEl.value?.reload()
}

/** 在系统浏览器里打开当前地址（模板里不能直接碰 window）。 */
function openExternal(url: string): void {
  void window.fd.webviewOpenExternal(url)
}

// --------------------------------------------------------------- 搜索

async function runSearch(): Promise<void> {
  const kw = searchKeyword.value.trim()
  if (!kw || searching.value) return
  searching.value = true
  searchDone.value = true
  resultsBySite.value = []
  try {
    // 并行搜所有站，返回顺序按注册表顺序排
    const outcomes = await Promise.all(
      sites.value.map(async (s) => ({
        site: s,
        outcome: await window.fd.sitesSearch(s.id, kw),
      })),
    )
    resultsBySite.value = outcomes.sort(
      (a, b) =>
        sites.value.findIndex((s) => s.id === a.site.id) -
        sites.value.findIndex((s) => s.id === b.site.id),
    )
  } catch {
    message.warning('搜索失败，请重试')
  } finally {
    searching.value = false
  }
}

// --------------------------------------------------------------- 镜像与解析

/** 展开某条结果的下载镜像，弹给用户选。 */
async function showMirrors(siteId: string, item: SiteSearchResult): Promise<void> {
  const outcome: SiteMirrorOutcome = await window.fd.sitesMirrors(siteId, item.url)
  if (!outcome.ok) {
    message.warning(outcome.message ?? '解析失败')
    return
  }
  const mirrors = outcome.mirrors ?? []
  if (!mirrors.length) {
    message.warning(outcome.message ?? '没有找到下载链接，请在浏览器里打开详情页。')
    return
  }
  // 触发页面级交互（用 antd Modal.confirm 太糙，这里用一个简单列表浮层）
  const chosen = await pickMirror(item.title, mirrors)
  if (!chosen) return
  await handleMirror(chosen)
}

/** 让用户在多镜像里选一个（浮层式选择）。 */
function pickMirror(title: string, mirrors: Mirror[]): Promise<Mirror | null> {
  return new Promise((resolve) => {
    const holder = document.createElement('div')
    holder.className = 'mirror-overlay'
    const box = document.createElement('div')
    box.className = 'mirror-box'
    box.innerHTML = `
      <div class="m-title"></div>
      <div class="m-list"></div>
      <div class="m-foot"><button class="m-cancel">取消</button></div>
    `
    holder.appendChild(box)
    box.querySelector('.m-title')!.textContent = `选择下载方式 — ${title}`
    const list = box.querySelector('.m-list')!
    for (const m of mirrors) {
      const row = document.createElement('div')
      row.className = 'm-row'
      row.innerHTML = `<span class="m-kind"></span><span class="m-name"></span>`
      const kind = row.querySelector('.m-kind')!
      kind.textContent = KIND_LABEL[m.kind] ?? m.kind
      row.querySelector('.m-name')!.textContent = m.note ? `${m.name}（${m.note}）` : m.name
      row.addEventListener('click', () => {
        holder.remove()
        resolve(m)
      })
      list.appendChild(row)
    }
    box.querySelector('.m-cancel')!.addEventListener('click', () => {
      holder.remove()
      resolve(null)
    })
    holder.addEventListener('click', (e) => {
      if (e.target === holder) {
        holder.remove()
        resolve(null)
      }
    })
    document.body.appendChild(holder)
  })
}

/** 镜像类型的中文标签（浮层里显示，避免直接露出 kind 原始值）。 */
const KIND_LABEL: Record<Mirror['kind'], string> = {
  pan: '网盘',
  gofile: 'GOFILE',
  direct: '直链',
  cloudreve: '网盘(自动)',
  torrent: '磁力',
  page: '页面',
}

/**
 * 处理用户选中的镜像：解析成直链 → 添加任务；解析不了的（网盘）给「在浏览器打开」。
 * page 镜像是页面链接（go 端点等反爬占位），不解析，直接在内嵌 webview 打开——
 * 那里有真实会话，页面内的真实文件下载会被捕获桥自动添加入 FastDrop。
 */
async function handleMirror(m: Mirror): Promise<void> {
  if (m.kind === 'page') {
    nav(m.url)
    message.info('已在页面中打开，请在页面里点击下载')
    return
  }
  const outcome = await window.fd.sitesResolve(m)
  if (outcome.ok && (outcome.files?.length || outcome.url)) {
    // 一个分享常有多个文件（RAR 分卷），逐个入队，全成功才算成功
    const list = outcome.files?.length
      ? outcome.files
      : [{ url: outcome.url!, filename: outcome.filename ?? '' }]
    let added = 0
    for (const f of list) {
      try {
        await window.fd.sitesAddTask({ url: f.url, filename: f.filename })
        added++
      } catch (e) {
        message.error(`添加任务失败：${(e as Error).message}`)
      }
    }
    if (added > 0) {
      message.success(added === 1 ? '已添加到 FastDrop 下载列表' : `已添加 ${added} 个分卷到下载列表`)
    }
    return
  }
  // 解析失败：网盘类回退到内嵌 webview，让用户用站点自带会话手动下载
  message.info(outcome.message ?? '该链接无法自动下载，请在页面里打开')
  if (m.kind === 'pan' || m.kind === 'gofile' || m.kind === 'cloudreve') {
    nav(m.url)
  } else {
    void window.fd.webviewOpenExternal(m.url)
  }
}

// --------------------------------------------------------------- 捕获桥

/** 订阅主进程的捕获推送：webview 里下载真实文件时弹「添加到 FastDrop」。 */
let unsubCapture: (() => void) | null = null
onMounted(() => {
  unsubCapture = window.fd.onDownloadCaptured(async (d: CapturedDownload) => {
    const name = d.filename || d.url.split('/').pop() || '下载'
    try {
      await window.fd.sitesAddTask({ url: d.url, filename: d.filename })
      message.success(`已添加：${name}`)
    } catch {
      message.warning(`无法自动添加 ${name}，请手动复制链接`)
    }
  })
})
onBeforeUnmount(() => {
  unsubCapture?.()
})
</script>

<template>
  <div class="games">
    <!-- 左：站点/结果 -->
    <aside class="g-side">
      <div class="g-sites">
        <button
          v-for="s in sites"
          :key="s.id"
          class="g-site"
          :class="{ active: s.id === activeSiteId }"
          @click="switchSite(s.id)"
        >
          <CompassOutlined class="g-site-ic" />
          <span>{{ s.name }}</span>
        </button>
      </div>

      <div class="g-search">
        <input
          v-model="searchKeyword"
          class="g-input"
          :placeholder="activeSite().searchPlaceholder"
          @keyup.enter="runSearch"
        />
        <button class="g-go" :disabled="searching" @click="runSearch">
          <SearchOutlined />
        </button>
      </div>

      <div class="g-results">
        <template v-if="searchDone">
          <div v-for="g in resultsBySite" :key="g.site.id" class="g-group">
            <div class="g-group-title">
              {{ g.site.name }}
              <span class="g-count">{{ g.outcome.results?.length ?? 0 }}</span>
            </div>
            <template v-if="g.outcome.ok">
              <div
                v-if="g.outcome.results?.length"
                class="g-result"
                v-for="r in g.outcome.results"
                :key="r.url"
                @click="showMirrors(g.site.id, r)"
              >
                <span class="g-result-title">{{ r.title }}</span>
              </div>
              <div v-else class="g-empty">{{ g.outcome.message ?? '无结果' }}</div>
            </template>
            <div v-else class="g-empty">{{ g.outcome.message }}</div>
          </div>
        </template>
        <div v-else class="g-hint">输入关键词搜索三个站点，点结果解析下载链接。</div>
      </div>
    </aside>

    <!-- 右：webview -->
    <div class="g-main">
      <div class="g-toolbar">
        <button class="g-nav-btn" :disabled="!canBack" @click="goBack">
          <ArrowLeftOutlined />
        </button>
        <button class="g-nav-btn" :disabled="!canForward" @click="goForward">
          <ArrowRightOutlined />
        </button>
        <button class="g-nav-btn" @click="reload">
          <ReloadOutlined :class="{ spin: loading }" />
        </button>
        <button class="g-nav-btn" title="回到站点首页" @click="goHome">
          <DownloadOutlined />
        </button>
        <input v-model="address" class="g-addr" @keyup.enter="nav(address)" />
        <button class="g-open" title="在系统浏览器打开当前页" @click="openExternal(address)">
          <LinkOutlined />
        </button>
      </div>
      <div class="g-title">{{ pageTitle }}</div>
      <div class="g-web">
        <webview
          ref="webviewEl"
          class="g-wv"
          :src="activeSite().home"
          partition="persist:gamesites"
          allowpopups
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.games {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 12px;
}
.g-side {
  flex: none;
  width: 300px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--ant-color-bg-container);
  border: 1px solid var(--ant-color-border);
  border-radius: var(--ant-radius);
  padding: 10px;
  overflow-y: auto;
}
.g-sites {
  display: flex;
  gap: 6px;
}
.g-site {
  flex: 1;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid var(--ant-color-border);
  border-radius: var(--ant-radius);
  background: transparent;
  color: var(--ant-color-text-secondary);
  cursor: pointer;
  font-size: 13px;
}
.g-site.active {
  background: var(--ant-color-primary-bg);
  border-color: var(--ant-color-primary);
  color: var(--ant-color-primary);
}
.g-site-ic {
  font-size: 13px;
}
.g-search {
  display: flex;
  gap: 6px;
}
.g-input {
  flex: 1;
  height: 32px;
  border: 1px solid var(--ant-color-border);
  border-radius: var(--ant-radius);
  background: var(--ant-color-bg-elevated);
  color: var(--ant-color-text);
  padding: 0 10px;
  font-size: 13px;
}
.g-input:focus {
  outline: none;
  border-color: var(--ant-color-primary);
}
.g-go {
  width: 36px;
  height: 32px;
  border: 1px solid var(--ant-color-border);
  border-radius: var(--ant-radius);
  background: var(--ant-color-primary);
  color: #fff;
  cursor: pointer;
}
.g-results {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
}
.g-group-title {
  font-size: 12px;
  color: var(--ant-color-text-tertiary);
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}
.g-count {
  font-family: var(--ant-font-family-code);
  font-size: 11px;
  color: var(--ant-color-text-quaternary);
}
.g-result {
  padding: 8px 10px;
  border: 1px solid var(--ant-color-border-secondary);
  border-radius: var(--ant-radius);
  margin-bottom: 6px;
  cursor: pointer;
  transition: border-color 0.15s;
}
.g-result:hover {
  border-color: var(--ant-color-primary);
}
.g-result-title {
  font-size: 13px;
  color: var(--ant-color-text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.g-empty {
  font-size: 12px;
  color: var(--ant-color-text-quaternary);
  padding: 4px 2px;
}
.g-hint {
  font-size: 12px;
  color: var(--ant-color-text-quaternary);
  padding: 8px 2px;
  line-height: 1.6;
}
.g-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.g-toolbar {
  display: flex;
  gap: 6px;
  align-items: center;
}
.g-nav-btn {
  width: 30px;
  height: 30px;
  border: 1px solid var(--ant-color-border);
  border-radius: var(--ant-radius);
  background: var(--ant-color-bg-container);
  color: var(--ant-color-text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.g-nav-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.g-addr {
  flex: 1;
  height: 30px;
  border: 1px solid var(--ant-color-border);
  border-radius: var(--ant-radius);
  background: var(--ant-color-bg-elevated);
  color: var(--ant-color-text);
  padding: 0 10px;
  font-size: 12px;
}
.g-open {
  width: 30px;
  height: 30px;
  border: 1px solid var(--ant-color-border);
  border-radius: var(--ant-radius);
  background: var(--ant-color-bg-container);
  color: var(--ant-color-text-secondary);
  cursor: pointer;
}
.g-title {
  font-size: 12px;
  color: var(--ant-color-text-tertiary);
  padding: 0 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.g-web {
  /* position: relative 是必须的：webview 是「替换元素」，它的内在尺寸会参与 flex
     计算，导致 flex:1 + min-height:0 装不下它——实测右侧面板只拿到 861px 高度，
     底部空出 476px。绝对定位把 webview 从 flex 流里摘出去，它就不再贡献内在高度，
     .g-web 由 flex:1 独占剩余空间。 */
  flex: 1;
  min-height: 0;
  position: relative;
  border: 1px solid var(--ant-color-border);
  border-radius: var(--ant-radius);
  overflow: hidden;
  background: #fff;
}
.g-wv {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
</style>

<style>
/* 镜像选择浮层：放在全局（scoped 会加 data 属性，动态 createElement 的 DOM 匹配不到）*/
.mirror-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
}
.mirror-box {
  width: 420px;
  max-width: 90vw;
  background: var(--ant-color-bg-elevated);
  border-radius: 8px;
  padding: 16px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
}
.m-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--ant-color-text);
  margin-bottom: 12px;
}
.m-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.m-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--ant-color-border-secondary);
  border-radius: 6px;
  cursor: pointer;
  transition: border-color 0.15s;
}
.m-row:hover {
  border-color: var(--ant-color-primary);
}
.m-kind {
  font-size: 11px;
  font-family: var(--ant-font-family-code);
  color: var(--ant-color-primary);
  background: var(--ant-color-primary-bg);
  padding: 2px 6px;
  border-radius: 4px;
}
.m-name {
  font-size: 13px;
  color: var(--ant-color-text);
}
.m-foot {
  margin-top: 12px;
  display: flex;
  justify-content: flex-end;
}
.m-cancel {
  border: none;
  background: transparent;
  color: var(--ant-color-text-secondary);
  font-size: 13px;
  cursor: pointer;
  padding: 4px 8px;
}
.spin {
  animation: fd-spin 1s linear infinite;
}
@keyframes fd-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>