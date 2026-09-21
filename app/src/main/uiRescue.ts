/**
 * 界面起不来时的自救出口。
 *
 * 以前这里什么都没有：产物缺文件、preload 没挂上、渲染进程崩掉——用户看到的都是
 * 一片白，唯一的办法是开任务管理器强杀。数据其实丢不了（任务与断点都在磁盘上），
 * 但「白屏 = 软件坏了」这一条印象足够让人直接删掉它。
 *
 * 三条检测路径各管一种失败方式，缺一条就有一类白屏没人报：
 *   did-fail-load       —— 页面本身没加载出来（打包产物缺文件、dev server 没起）
 *   render-process-gone —— 加载出来过，渲染进程随后崩了 / 被系统结束
 *   看门狗              —— 页面加载成功但脚本没跑起来（preload 缺失、启动期抛错），
 *                          这种只能等渲染层的「我挂载完了」，等不到就报
 *
 * 兜底页上的按钮故意不走 IPC：preload 本身就可能正是坏掉的那一环，那时 window.fd
 * 并不存在。点击只改 hash，主进程在 did-navigate-in-page 里接单——不依赖页面里
 * 任何一座桥。
 */
import { BrowserWindow, dialog, shell } from 'electron'
import type { WebContents } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 看门狗的时限。取 15 秒而不是更早：这台机器上正常首屏不到 1 秒，但磁盘冷、
 * 杀毒软件扫产物、调试器挂着时会明显变慢——误判把一个好界面换成兜底页，
 * 比白屏更难解释。
 */
export const WATCHDOG_MS = 15000

/** 界面卡死多久才弹窗。短于这个值的卡顿会自己恢复，弹窗就成了骚扰。 */
const UNRESPONSSIVE_MS = 8000

export const RESCUE_FILE = 'ui-rescue.html'

export interface UiRescueDeps {
  /** 兜底页写到哪个目录（userData） */
  pageDir: string
  /** 设置与任务记录所在目录，给「打开数据目录」用 */
  dataDir: string
  downloadDir: () => string
  getWindow: () => BrowserWindow | null
  reloadUi: () => void
  quitApp: () => void
}

/** 渲染进程消失的原因翻成人话；没见过的 reason 原样带出去，别编。 */
const GONE_REASON: Record<string, string> = {
  crashed: '界面进程崩溃了',
  killed: '界面进程被结束（系统或安全软件动的可能性都有）',
  oom: '界面进程用完了内存，被系统结束',
  'launch-failed': '界面进程没能启动（显卡驱动或安全软件拦下最常见）',
  'integrity-failure': '界面程序校验没通过，文件可能被改动过',
}

export function goneReasonText(reason: string, exitCode: number): string {
  return `${GONE_REASON[reason] ?? `界面进程退出了（原因 ${reason}）`}，退出码 ${exitCode}`
}

/** 兜底页正文。单独导出是为了让测试能钉住「原因有没有原样显示」「转义有没有做」。 */
export function rescueHtml(reason: string, detail: string, dirs: { data: string; download: string }): string {
  const esc = (s: string): string =>
    s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)
  const li = (act: string, label: string, note: string) =>
    `<li><a href="#${act}" data-act="${act}">${label}</a><i>${note}</i></li>`
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>FastDrop 界面没能正常显示</title>
<style>
  :root { color-scheme: light dark; --fg:#1c1c1e; --mut:#6b6b70; --bd:#d9d9de; --bg:#fff; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e8e8ea; --mut:#9a9aa0; --bd:#3a3a40; --bg:#17171a; } }
  body { margin:0; padding:48px 28px; background:var(--bg); color:var(--fg);
         font:15px/1.65 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
  main { max-width:640px; margin:0 auto; }
  h1 { font-size:19px; margin:0 0 14px; }
  .why { border-left:3px solid #d0453f; padding:8px 12px; margin:0 0 6px; background:rgba(208,69,63,.06); }
  .why b { display:block; font-size:12px; color:var(--mut); font-weight:600; letter-spacing:.02em; }
  .detail { margin:0 0 22px; font-size:12.5px; color:var(--mut); word-break:break-all; white-space:pre-wrap; }
  ul { list-style:none; padding:0; margin:0 0 22px; border:1px solid var(--bd); border-radius:8px; overflow:hidden; }
  li { padding:11px 14px; border-top:1px solid var(--bd); }
  li:first-child { border-top:0; }
  a { display:inline-block; font-weight:600; text-decoration:none; color:#2f6fed; }
  a:hover { text-decoration:underline; }
  i { display:block; font-style:normal; font-size:12.5px; color:var(--mut); margin-top:2px; }
  .path { font-size:12px; color:var(--mut); word-break:break-all; }
  .tip { font-size:12.5px; color:var(--mut); margin:0; }
</style></head>
<body><main>
  <h1>FastDrop 的界面没能正常显示</h1>
  <p class="why"><b>这次的原因</b>${esc(reason)}</p>
  ${detail ? `<p class="detail">${esc(detail)}</p>` : ''}
  <ul>
    ${li('reload', '重新加载界面', '先再试一次；多数时候是偶发的，下载任务不会因为这个页面停掉')}
    ${li('data', '打开数据目录', '设置（settings.json）与任务记录（tasks.json）都在这里；界面反复起不来时把它们发给开发者')}
    ${li('downloads', '打开下载目录', dirs.download ? esc(`已下载的文件在 ${dirs.download}`) : '')}
    ${li('quit', '退出程序', '已经下完的部分留在断点，下次打开自动续传')}
  </ul>
  <p class="path">数据目录：${esc(dirs.data)}</p>
  <p class="tip">反复回到这一页的话，上面那句「这次的原因」就是最要紧的线索，不用另外描述「打不开」。</p>
</main>
<script>
  // 每次点击都换一个 hash：同一串 hash 再点不会产生导航，主进程就收不到第二次。
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[data-act]') : null
    if (!a) return
    e.preventDefault()
    location.hash = a.getAttribute('data-act') + '-' + Date.now()
  })
</script>
</body></html>`
}

type Action = 'reload' | 'data' | 'downloads' | 'quit'

/** `#reload-1737000000000` → `reload`。没有 nonce 的裸 `#reload`（无 JS 时）也认。 */
export function actionOfHash(hash: string): Action | null {
  const name = hash.replace(/^#/, '').split(/[-.]/)[0]
  return name === 'reload' || name === 'data' || name === 'downloads' || name === 'quit' ? name : null
}

export class UiRescue {
  private ready = false
  private showing = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private unrespTimer: ReturnType<typeof setTimeout> | null = null
  private bootDetail = ''

  constructor(private deps: UiRescueDeps) {}

  /**
   * 每次真的去加载界面前调用：重新计时并清掉「已就绪」。
   *
   * timeoutMs 只有离线门会传——测试等不起 15 秒，而把时限写成不可调的常量，
   * 就等于这条路径没法被验证。
   */
  arm(timeoutMs: number = WATCHDOG_MS): void {
    this.ready = false
    // 每一次真的去加载界面都是一次全新的尝试：上一轮兜底页的「正在展示」状态必须
    // 一起清掉，否则窗口被销毁重建（关窗后从托盘再开）之后 showing 还挂着 true，
    // 这一轮再白屏就直接不报了——又回到没有出口的老样子。
    this.showing = false
    this.bootDetail = ''
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.ready || this.showing) return
      this.show(`页面加载完了，但界面脚本在 ${Number((timeoutMs / 1000).toFixed(1))} 秒内没有跑起来。preload 没加载或启动期报错都会是这个表现。`)
    }, timeoutMs)
  }

  /** 渲染层挂载完成。看门狗到此为止，之后不再拦。 */
  markReady(): void {
    this.ready = true
    this.clearTimer()
  }

  /** 渲染层报上来的启动错误：只作为兜底页的补充说明，不单独触发兜底页。 */
  noteBootError(detail: string): void {
    if (this.ready) return
    this.bootDetail = detail.slice(0, 600)
  }

  /** 挂到一扇新窗口的 webContents 上。每条路径都指回同一个 show()。 */
  attach(wc: WebContents): void {
    // ERR_ABORTED(-3) 是我们自己换页（含加载兜底页）打断上一次导航，不是故障。
    // 这里不看 ready：主框架导航失败后屏幕上就是空的，界面先前起没起过都一样。
    wc.on('did-fail-load', (_e, code, desc, _url, isMain) => {
      if (!isMain || code === -3 || this.showing) return
      this.show(`界面文件没能加载：${desc || '未知错误'}（错误码 ${code}）。打包产物不完整或安装被中断过时常见。`)
    })
    wc.on('render-process-gone', (_e, d) => {
      if (this.showing) return
      this.show(goneReasonText(d.reason, d.exitCode))
    })
    wc.on('did-navigate-in-page', (_e, url) => {
      if (!this.showing) return
      let hash = ''
      try {
        hash = new URL(url).hash
      } catch {
        return
      }
      const act = actionOfHash(hash)
      if (!act) return
      void this.run(act)
    })
    // 卡住不立刻弹窗：渲染进程被一个长任务占住时就会报 unresponsive，缓过来时
    // responsive 会把定时器撤掉。只有持续卡到超时才打扰用户。
    wc.on('unresponsive', () => {
      if (this.unrespTimer) return
      this.unrespTimer = setTimeout(() => {
        this.unrespTimer = null
        if (wc.isDestroyed()) return
        this.askWhileFrozen()
      }, UNRESPONSSIVE_MS)
    })
    wc.on('responsive', () => {
      if (this.unrespTimer) {
        clearTimeout(this.unrespTimer)
        this.unrespTimer = null
      }
    })
  }

  pagePath(): string {
    return join(this.deps.pageDir, RESCUE_FILE)
  }

  private show(reason: string): void {
    if (this.showing) return
    const win = this.deps.getWindow()
    if (!win || win.isDestroyed()) return
    this.showing = true
    this.clearTimer()
    // 兜底页必须被看见。首屏就坏时 ready-to-show 可能从没触发过，窗口一直藏着，
    // 用户读到的表现是「双击图标没反应」，连有这么个页面都不知道。
    win.show()
    const html = rescueHtml(reason, this.bootDetail, {
      data: this.deps.dataDir,
      download: this.deps.downloadDir(),
    })
    try {
      writeFileSync(this.pagePath(), html, 'utf8')
    } catch (e) {
      // 连兜底页都写不下去（磁盘满、目录没权限）时还剩一条路：原生对话框。
      // 这里静默等于把用户留在白屏上，而这是整套兜底逻辑要解决的唯一问题。
      void this.dialogFallback(`${reason}（兜底页也写不出来：${e instanceof Error ? e.message : String(e)}）`)
      return
    }
    void win.loadFile(this.pagePath()).catch((e: unknown) => {
      void this.dialogFallback(`${reason}（兜底页没能显示：${e instanceof Error ? e.message : String(e)}）`)
    })
  }

  private async dialogFallback(reason: string): Promise<void> {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'FastDrop 界面没能正常显示',
      message: 'FastDrop 的界面没能正常显示',
      detail: `${reason}\n\n数据目录：${this.deps.dataDir}`,
      buttons: ['重新加载界面', '打开数据目录', '退出程序'],
      noLink: true,
    })
    await this.run((['reload', 'data', 'quit'] as const)[response] ?? 'quit')
  }

  /** 界面卡住时唯一的出口：一个不依赖那扇卡住的窗口渲染的原生对话框。 */
  private askWhileFrozen(): void {
    void (async () => {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        title: 'FastDrop 界面无响应',
        message: '界面已经卡住 8 秒以上',
        detail: '下载任务在主进程里跑着，不受这个窗口影响。可以继续等它自己缓过来，也可以重载界面或直接退出。',
        buttons: ['继续等待', '重新加载界面', '退出程序'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      if (response === 1) this.deps.reloadUi()
      else if (response === 2) this.deps.quitApp()
    })()
  }

  private async run(act: Action): Promise<void> {
    if (act === 'reload') {
      // 先让位再重载：不置回 showing，兜底页会挡住后续的 did-fail-load 上报，
      // 第二次失败就静默了——那正是「点了没反应」。
      this.showing = false
      this.bootDetail = ''
      this.deps.reloadUi()
      return
    }
    if (act === 'quit') {
      this.showing = false
      this.deps.quitApp()
      return
    }
    const p = act === 'data' ? this.deps.dataDir : this.deps.downloadDir()
    const why = await shell.openPath(p)
    if (why) {
      // 打不开目录本身就是这次自救的失败，必须让用户知道，别只当没点到。
      void dialog.showMessageBox({
        type: 'warning',
        message: `打不开该目录：${why}`,
        detail: p,
        buttons: ['好'],
        noLink: true,
      })
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
