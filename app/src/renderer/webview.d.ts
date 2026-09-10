/**
 * <webview> 元素的 TypeScript 声明。Electron 的 webview 不是标准 HTML 元素，
 * DOM lib 里没有它；这里声明最小可用子集（方法/事件/属性按需补）。
 */
declare global {
  interface HTMLElementTagNameMap {
    webview: WebviewElement
  }
}

/** 渲染进程能用的 webview API 子集。完整列表见 Electron 文档。 */
export interface WebviewElement extends HTMLElement {
  /** 加载的 URL；可写，写入即导航 */
  src: string
  partition: string
  useragent: string

  reload(): void
  goBack(): void
  goForward(): void
  stop(): void
  canGoBack(): boolean
  canGoForward(): boolean
  getURL(): string
  getTitle(): string
  /** 执行页面里的 JS，返回 Promise */
  executeJavaScript(code: string): Promise<unknown>
  loadURL(url: string): Promise<void>

  addEventListener(type: 'did-start-loading', cb: () => void): void
  addEventListener(type: 'did-stop-loading', cb: () => void): void
  addEventListener(type: 'did-navigate', cb: (e: { url: string }) => void): void
  addEventListener(type: 'did-navigate-in-page', cb: (e: { url: string; isMainFrame: boolean }) => void): void
  addEventListener(type: 'page-title-updated', cb: (e: { title: string }) => void): void
}

export {}