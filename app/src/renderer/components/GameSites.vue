/**
 * 游戏站页签：内嵌浏览器 + 搜索聚合 + 直链捕获。
 *
 * 左侧是站点列表与聚合搜索结果，右侧是 webview（partition=persist:gamesites，
 * 登录状态跨重启保持）。页面里点下载时主进程的捕获桥负责分流，并把结果推到
 * push:site-download：公开直链进 FastDrop 引擎、需要会话的链接交回浏览器下载。
 * 订阅在 renderer/store.ts 里做（切走页签也不能丢消息），这里只管浏览与解析。
 *
 * webview 是 Electron 的 OOPIF，有自己的进程与会话；它在沙箱化渲染进程里
 * 也能用（webviewTag: true 在主进程开）。注意：webview 的 DOM 事件需要
 * 在元素上直接挂监听，不能用 Vue 的 @事件语法（部分事件不冒泡）。
 */
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
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
  ResolveOutcome,
  SiteInfo,
  SiteMirrorOutcome,
  SiteSearchOutcome,
  SiteSearchResult,
} from '../../shared/sites'
import { GAMESITES_PARTITION } from '../../shared/sites'
import type { WebviewElement } from '../webview'
import { reportRejection } from '../store'

const sites = ref<SiteInfo[]>([])
const activeSiteId = ref<string>('gamer520')

const searchKeyword = ref('')
const searchDone = ref(false)
/** 每个站一列，各列独立结项（谁先回来谁先能看） */
interface SiteGroup {
  site: SiteInfo
  /** 这一列是用哪个词搜的：「重试」重放的是它，不是输入框里的当前文字 */
  kw: string
  pending: boolean
  outcome: SiteSearchOutcome | null
}
const resultsBySite = ref<SiteGroup[]>([])
/** 还在跑的站点数。>0 只让按钮转圈，不禁用：新搜索会直接作废旧结果。 */
const pendingCount = computed(() => resultsBySite.value.filter((g) => g.pending).length)
/**
 * 搜索序号。慢站回包时用户可能已经换词重搜，拿序号对一下才能把旧结果丢掉——
 * 否则「playzip 20 秒后回来的那批结果」会盖在用户正在看的新结果上。
 */
let searchSeq = 0

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
  if (!kw) return
  const seq = ++searchSeq
  searchDone.value = true
  resultsBySite.value = sites.value.map((site) => ({
    site,
    kw,
    pending: true,
    outcome: null,
  }))
  // 每站各走各的：谁先回来谁先上屏。以前是 Promise.all 一起结项，
  // 一个站卡在重试里，另外两个早就搜到的结果也得陪着被藏起来。
  await Promise.all(sites.value.map((site) => searchOne(seq, site, kw)))
}

async function searchOne(seq: number, site: SiteInfo, kw: string): Promise<void> {
  let outcome: SiteSearchOutcome
  try {
    outcome = await window.fd.sitesSearch(site.id, kw)
  } catch (e) {
    // 单站的异常就地摊开在这一列上，不弹全局红条：其它站的结果照样能用，
    // 一句「操作失败」既盖不住信息也说不清是哪个站。
    outcome = {
      ok: false,
      siteId: site.id,
      message: `这次没能发起搜索：${e instanceof Error ? e.message : String(e)}`,
    }
  }
  if (seq !== searchSeq) return
  const g = resultsBySite.value.find((x) => x.site.id === site.id)
  if (!g) return
  g.outcome = outcome
  g.pending = false
}

/** 只重跑这一站。失败原因只属于这一次搜索，所以出口是「再来一次」而不是把站判死。 */
function retrySite(g: SiteGroup): void {
  const seq = searchSeq
  g.pending = true
  g.outcome = null
  void searchOne(seq, g.site, g.kw)
}

// --------------------------------------------------------------- 镜像与解析

/**
 * 解析过程中的转圈用这个 key，进度靠同 key 原地替换文案；
 * 最终结果另发一条（不带 key），收尾时不会把结果一起删掉。
 */
const LOADING_KEY = 'gamesites-mirror-loading'

/**
 * 一次「点结果 → 选镜像 → 解析网盘 → 排队入列」的完整过程是否正在进行。
 * 网盘列目录能拖十几秒，而这段时间屏幕上什么都不动：用户以为没点上，
 * 再点一次就会并发解析同一个分享页。
 */
const mirrorBusy = ref(false)

function showProgress(text: string): void {
  message.loading({ content: text, key: LOADING_KEY, duration: 0 })
}

/** 展开某条结果的下载镜像，弹给用户选。 */
async function showMirrors(siteId: string, item: SiteSearchResult): Promise<void> {
  if (mirrorBusy.value) {
    // 连点时也要给句话。什么都不发生，用户读作「卡了」，然后继续点。
    message.info({ content: '上一个链接还在解析，先等它出结果', key: 'gamesites-busy', duration: 2 })
    return
  }
  mirrorBusy.value = true
  showProgress(`正在读取「${item.title}」的下载链接…`)
  try {
    let outcome: SiteMirrorOutcome
    try {
      outcome = await window.fd.sitesMirrors(siteId, item.url)
    } catch (e) {
      reportRejection(e)
      return
    }
    if (!outcome.ok) {
      message.destroy(LOADING_KEY)
      message.warning(outcome.message ?? '解析失败')
      return
    }
    const mirrors = outcome.mirrors ?? []
    if (!mirrors.length) {
      message.destroy(LOADING_KEY)
      message.warning(outcome.message ?? '没有找到下载链接，请在浏览器里打开详情页。')
      return
    }
    // 浮层是要用户做决定的，不是在进行中——转圈先收掉，别让他以为还在加载
    message.destroy(LOADING_KEY)
    const chosen = await pickMirror(item.title, mirrors)
    if (!chosen) return
    await handleMirror(chosen)
  } finally {
    message.destroy(LOADING_KEY)
    mirrorBusy.value = false
  }
}

/**
 * 当前挂着的镜像浮层。
 *
 * 它是 createElement 出来的、直接贴在 document.body 上，不属于组件树——
 * 组件卸载（用户切回「下载管理」）时 Vue 不会替我们摘掉它。以前浮层就那样
 * 留在原地：一层全屏半透明遮罩盖住整个窗口，谁都点不动，只能重启软件。
 */
let activeMirrorHolder: HTMLElement | null = null

/** 让用户在多镜像里选一个（浮层式选择）。 */
function pickMirror(title: string, mirrors: Mirror[]): Promise<Mirror | null> {
  return new Promise((resolve) => {
    // 同一时刻只该有一个浮层：上一个还挂着就先摘掉，避免遮罩叠遮罩
    activeMirrorHolder?.remove()
    const holder = document.createElement('div')
    activeMirrorHolder = holder
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
      row.addEventListener('click', () => close(m))
      list.appendChild(row)
    }
    box.querySelector('.m-cancel')!.addEventListener('click', () => close(null))
    holder.addEventListener('click', (e) => {
      if (e.target === holder) close(null)
    })
    document.body.appendChild(holder)

    function close(result: Mirror | null): void {
      if (activeMirrorHolder === holder) activeMirrorHolder = null
      holder.remove()
      resolve(result)
    }
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
  showProgress(`正在解析 ${KIND_LABEL[m.kind]}「${m.name}」…`)
  let outcome: ResolveOutcome
  try {
    outcome = await window.fd.sitesResolve(m)
  } catch (e) {
    reportRejection(e)
    return
  }
  if (outcome.ok && (outcome.files?.length || outcome.url)) {
    // 一个分享常有多个文件（RAR 分卷），逐个入队；失败的每一个都要报出来
    const list = outcome.files?.length
      ? outcome.files
      : [{ url: outcome.url!, filename: outcome.filename ?? '' }]
    let added = 0
    let dups = 0
    const failed: string[] = []
    for (let i = 0; i < list.length; i++) {
      const f = list[i]!
      if (list.length > 1) showProgress(`正在加入下载列表（${i + 1}/${list.length}）…`)
      try {
        const r = await window.fd.sitesAddTask({ url: f.url, filename: f.filename })
        if (r.ok && !r.duplicate) added++
        else if (r.ok) dups++
        else failed.push(`${f.filename || '该文件'}：${r.error}`)
      } catch (e) {
        reportRejection(e)
      }
    }
    message.destroy(LOADING_KEY)
    // 分享里的文件超过单次解析上限时会被截断。只报「还有 M 个未加入」等于把活儿
    // 丢回给用户——他得自己找回那个分享页。这里直接把分享页摊到右侧浏览器里。
    let note = outcome.message ?? ''
    if ((outcome.missing ?? 0) > 0 && (m.kind === 'cloudreve' || m.kind === 'gofile')) {
      nav(m.url)
      note = note ? `${note}，已在右侧浏览器打开` : '剩余文件已在右侧浏览器打开'
    }
    reportResolve(added, dups, failed, note)
    return
  }
  // 解析失败：网盘类回退到内嵌 webview，让用户用站点自带会话手动下载
  message.destroy(LOADING_KEY)
  message.info(outcome.message ?? '该链接无法自动下载，请在页面里打开')
  if (m.kind === 'pan' || m.kind === 'gofile' || m.kind === 'cloudreve') {
    nav(m.url)
  } else {
    void window.fd.webviewOpenExternal(m.url)
  }
}

/**
 * 把一次解析的结果合成一条提示。
 *
 * 分卷任务一多，逐条弹消息会变成几十条堆叠的 toast（用户只能看着它们排队消失），
 * 所以这里汇总成一条；更要紧的是 outcome.message——主进程解析器在里面写的是
 * 「共 N 个文件（还有 M 个文件未加入，可在分享页查看）」这种截断告知。
 * 60 个分卷只下了一半却不说，用户拿到手才发现缺件。
 */
function reportResolve(added: number, dups: number, failed: string[], note?: string): void {
  const parts: string[] = []
  if (added) parts.push(added === 1 ? '已添加到下载列表' : `已添加 ${added} 个文件`)
  if (dups) parts.push(`${dups} 个已在下载列表`)
  if (failed.length) parts.push(`${failed.length} 个失败：${failed[0]}`)
  if (note) parts.push(note)
  if (!parts.length) parts.push('没有文件被加入下载列表')
  const important = failed.length > 0 || !!note
  message.open({
    content: parts.join(' · '),
    type: failed.length ? 'warning' : added ? 'success' : 'info',
    // 截断告知和失败明细比「成功了」更需要读完，3 秒不够
    duration: important ? 8 : 3,
  })
}

onBeforeUnmount(() => {
  // 浮层挂在 document.body 上，不随组件销毁；不主动摘掉就会留下一层吃掉全窗点击的遮罩
  activeMirrorHolder?.remove()
  activeMirrorHolder = null
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
        <button class="g-go" title="搜索" @click="runSearch">
          <SearchOutlined :class="{ spin: pendingCount > 0 }" />
        </button>
      </div>

      <div class="g-results">
        <template v-if="searchDone">
          <div v-for="g in resultsBySite" :key="g.site.id" class="g-group">
            <div class="g-group-title">
              {{ g.site.name }}
              <span v-if="g.pending" class="g-count">搜索中…</span>
              <span v-else class="g-count">{{ g.outcome?.results?.length ?? 0 }}</span>
              <button
                v-if="!g.pending && g.outcome && !g.outcome.ok"
                class="g-retry"
                @click="retrySite(g)"
              >
                重试
              </button>
            </div>
            <div v-if="g.pending" class="g-empty">正在检索 {{ g.site.name }}…</div>
            <template v-else-if="g.outcome?.ok">
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
            <div v-else class="g-empty">{{ g.outcome?.message }}</div>
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
          :partition="GAMESITES_PARTITION"
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
  /* 侧栏只要放得下站点按钮和搜索框。原来 300px 把网页挤到 658px，
     内嵌浏览器里那些站点本来就是按 1000px+ 排的，越窄越难读。 */
  flex: none;
  width: 252px;
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
  flex-wrap: wrap;
  gap: 6px;
}
.g-site {
  /* 不拉伸：换行时最后一个按钮跟着文字宽度走，而不是摊满整行 */
  flex: 0 1 auto;
  height: 32px;
  padding: 0 8px;
  white-space: nowrap;
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
/* 单站重试：贴在列头右端，只重跑这一列，不动其它站已出的结果 */
.g-retry {
  margin-left: auto;
  height: 20px;
  padding: 0 8px;
  font-size: 11px;
  color: var(--ant-color-text-secondary);
  background: transparent;
  border: 1px solid var(--ant-color-border);
  border-radius: var(--ant-radius);
  cursor: pointer;
}
.g-retry:hover {
  color: var(--ant-color-primary);
  border-color: var(--ant-color-primary);
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
  /* 必须显式 min-width:0：<input> 的固有宽度约 183px，而 flex 项默认 min-width:auto
     不允许缩到固有宽度以下。窗口拖到 820 以下时（minWidth 是 780，用户真能拖到），
     地址栏顶住不让步，整条工具栏就要 359px，而面板只剩 300px——
     实测「在浏览器中打开」按钮被推到视口外（right 867 > 视口 820），
     连带 .shell 出现横向滚动。 */
  min-width: 0;
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