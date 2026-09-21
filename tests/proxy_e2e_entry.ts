/**
 * 代理链路与首屏自救的离线自检入口。
 *
 * 由 tests/test_proxy_e2e.py 用仓库自带的 esbuild 打包成 main 脚本，交给 Electron
 * 在隔离的 --user-data-dir 下跑。这里刻意只依赖 sites/ 下的解析模块、netConfig.ts
 * 的代理下发、engine.ts 的任务封装、uiRescue.ts 的首屏兜底，不启动 FastDrop 本体：
 * 要验证的就是「这几处是不是真的按同一份约定工作」，
 * 把整个 App 拉起来只会让失败原因更难定位。
 *
 * 结果按 `FD_RESULT <json>` 逐行打到 stdout，由 python 侧判定。
 */
import { app, BrowserWindow } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { EngineTask } from '../app/src/main/engine'
import { fetchText } from '../app/src/main/sites/http'
import { applyChromiumProxy, engineProxyFor } from '../app/src/main/netConfig'
import { parseSearchResults as parseGamer520 } from '../app/src/main/sites/gamer520'
import { parseSearchResults as parseNekogal } from '../app/src/main/sites/nekogal'
import { siteIdForUrl } from '../app/src/main/sites/registry'
import { crBundleNote, resolveMirror } from '../app/src/main/sites/resolver'
import { UiRescue, actionOfHash, goneReasonText, RESCUE_FILE } from '../app/src/main/uiRescue'

interface Check {
  name: string
  pass: boolean
  detail: string
}

const checks: Check[] = []
function check(name: string, pass: boolean, detail = ''): void {
  checks.push({ name, pass, detail })
  process.stdout.write(`FD_RESULT ${JSON.stringify({ name, pass, detail })}\n`)
}

const ORIGIN = String(process.env.FD_ORIGIN_BASE ?? '')
const PROXY = `http://127.0.0.1:${process.env.FD_PROXY_PORT ?? ''}`

/**
 * 每一步单独兜住异常。
 *
 * 不是为了「继续跑」而吞错：一步抛异常就把后面几步一起丢掉的话，
 * 看到的是「harness 挂了」，而不是「第 3 步的形状假设错了」——后者才是这里要测的东西。
 */
async function step(name: string, fn: () => Promise<[boolean, string]>): Promise<void> {
  try {
    const [pass, detail] = await fn()
    check(name, pass, detail)
  } catch (e) {
    check(name, false, `抛出异常：${e instanceof Error ? `${e.message}` : String(e)}`)
  }
}

/** 轮询到条件成立；超时返回 false，失败信息由调用方自己组织。 */
async function waitUntil(fn: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  for (;;) {
    if (fn()) return true
    if (Date.now() > until) return false
    await new Promise((r) => setTimeout(r, 50))
  }
}

const TMP_ROOT = String(process.env.FD_TMP ?? app.getPath('temp'))

async function main(): Promise<void> {
  // 兜底测试要开真窗口、用完就 destroy。Electron 的默认行为是「最后一个窗口关了
  // 就退进程」（FastDrop 自己在 main/index.ts 里接管了这一条），这里不接管的话，
  // 后面的步骤会在上一步销毁窗口时被一起带走，实测表现为 loadFile 报 ERR_FAILED(-2)
  // ——进程已经在退了，看着却像被测代码坏了。
  app.on('window-all-closed', () => {})

  // 1) 不配代理时源站直接 403（它只认代理注入的那个头）。
  //    这一步是「代理没生效就别想通」的下界，缺了它第 2 步 PASS 也证明不了什么。
  await step('抓取层：不配代理被源站拒绝', async () => {
    await applyChromiumProxy('')
    const direct = await fetchText(`${ORIGIN}/file.bin`, { sessionKind: 'anon', timeoutMs: 8000 })
    return [
      direct.status === 403,
      `status=${direct.status} statusText=${direct.statusText} body=${direct.text.slice(0, 80)}`,
    ]
  })

  // 2) 同一份设置里只改代理，同一地址就得变成 200 —— 这才叫 setProxy 真下发到了抓取层。
  await step('抓取层：配代理后取到正文', async () => {
    await applyChromiumProxy(PROXY)
    const via = await fetchText(`${ORIGIN}/file.bin`, { sessionKind: 'anon', timeoutMs: 8000 })
    return [
      via.status === 200 && via.text === 'FAKE-FILE-CONTENT',
      `status=${via.status} body=${JSON.stringify(via.text.slice(0, 80))}`,
    ]
  })

  // 3) 「留空 = 跟随系统代理」这条链的产物必须是 reqwest 吃得下的 URL。
  //    形状断言（`PROXY host:port` → `http://host:port`）以前全靠猜，这里钉死。
  await step('系统代理解析出引擎可用串', async () => {
    const forEngine = await engineProxyFor(`${ORIGIN}/file.bin`, '')
    return [forEngine === PROXY, `got=${forEngine}`]
  })

  // 4) 非法代理串必须当场抛可读原因。静默退回直连是这类配置最坏的失败方式：
  //    用户以为代理开着，实际上一路直连，看到的却是「站点 403」。
  await step('非法代理串当场拒绝', async () => {
    let rejected = ''
    try {
      await applyChromiumProxy('ftp://proxy.invalid:21')
    } catch (e) {
      rejected = e instanceof Error ? e.message : String(e)
    }
    return [rejected.includes('不支持的代理协议'), `msg=${rejected}`]
  })

  // 5) 缺 scheme 的写法（用户最常这么填）要归一化成 http://，否则引擎那边解析不出来。
  await step('裸 host:port 归一化为 http://', async () => {
    const bare = await engineProxyFor(
      `${ORIGIN}/file.bin`,
      `127.0.0.1:${process.env.FD_PROXY_PORT}`,
    )
    return [bare === PROXY, `got=${bare}`]
  })

  // 6) 「下载失败 → 去设置里填代理 → 回来点继续下载」这条自救路径必须真的换出口。
  //
  // 为什么单独测这一条：引擎的 reqwest client 只在 probe 时按代理建，run 命令里
  // 根本没有代理字段，而任务失败后子进程**不会退出**——复用那个老进程就等于继续
  // 用上一轮的 client，用户看到的仍然是上一轮那个错。
  // 这一条以前只有仓库外的手工 CDP 脚本能证伪，改回「构造期定死代理」都不会有人发现。
  //
  // 第一轮故意走「只放行探测」那台代理：probe 能成（probed 置为 true），run 才 403。
  // 只有这种失败才真正考验换进程那一步——第二轮若复用旧进程，sendStartCommands
  // 会跳过 probe 只发 run，新代理串根本送不进引擎。
  await step('引擎任务：改代理后重跑下得完', async () => {
    const dir = path.join(TMP_ROOT, 'tasknet')
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    const dest = path.join(dir, 'out.bin')
    const PROBE_ONLY = `127.0.0.1:${process.env.FD_PROXY_PORT_PROBE_ONLY}`
    const task = new EngineTask(`${ORIGIN}/f.bin`, dest, 4, PROBE_ONLY)
    const settle = async (ms: number): Promise<string> => {
      const until = Date.now() + ms
      for (;;) {
        if (task.state === 'done' || task.state === 'error') return task.state
        if (Date.now() > until) return `timeout(${task.state})`
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    try {
      task.run()
      const first = await settle(60000)
      const firstErr = task.error
      task.setNetworkConfig(`127.0.0.1:${process.env.FD_PROXY_PORT}`, '')
      task.run()
      const second = await settle(90000)
      const got = fs.existsSync(dest)
        ? crypto.createHash('md5').update(fs.readFileSync(dest)).digest('hex')
        : ''
      const want = String(process.env.FD_BODY_MD5)
      return [
        first === 'error' && /403/.test(firstErr) && second === 'done' && got === want,
        `第一轮=${first} 错误=${JSON.stringify(firstErr.slice(0, 60))} 第二轮=${second} md5对=${got === want}`,
      ]
    } finally {
      task.kill()
    }
  })

  // 7) 播报的措辞与算术，包括「什么都没缺时别硬凑一句」。
  await step('分享截断/失败计数进播报', async () => {
    const cut = crBundleNote('某游戏 第1卷', 74, 14, 2)
    const whole = crBundleNote('某游戏 第2卷', 60, 0, 0)
    const pass =
      cut.missing === 16 &&
      whole.missing === 0 &&
      cut.message.includes('共 74 个文件') &&
      cut.message.includes('还有 14 个文件未加入') &&
      cut.message.includes('另有 2 个文件取直链失败') &&
      !whole.message.includes('未加入') &&
      !whole.message.includes('失败')
    return [pass, `截断=${JSON.stringify(cut)} 完整=${JSON.stringify(whole)}`]
  })

  // 8) 上面那条只钉住措辞与算术：extra/failed 到底有没有从解析流程里喂进来，
  //    它一个字都没证明（把 `failed` 落在那句拼接之外，两条断言照样全绿）。
  //    这一步真调 resolveMirror，让它去问一个本地假 Cloudreve（120 个文件、
  //    第 4 个换直链故意 500），核对回来的数量确实是截断后的那一截。
  await step('网盘解析：截断与失败数真的喂进播报', async () => {
    const r = await resolveMirror({
      kind: 'cloudreve',
      name: 'FD-FAKE-SHARE',
      url: 'https://pan.nekogal.top/s/fdtest',
    })
    const pass =
      r.ok === true &&
      (r.files?.length ?? 0) === 59 &&
      r.missing === 61 &&
      !!r.message?.includes('共 120 个文件') &&
      !!r.message?.includes('还有 60 个文件未加入') &&
      !!r.message?.includes('另有 1 个文件取直链失败')
    return [pass, `ok=${r.ok} files=${r.files?.length} missing=${r.missing} message=${JSON.stringify(r.message)}`]
  })

  // 9) 列表页 href 的写法假设。
  //
  // 以前两个站的正则里把绝对域名写死（https://www.gamer520.com/\d+\.html），站点一旦
  // 改用相对路径我们就解析出 0 条，然后把「我们的假设错了」报成「站点已改版」。
  // 现在绝对/相对/协议相对都吃，外域同形链接与站内非文章链接仍然必须挡掉。
  await step('列表解析：三种 href 写法都归一化，外域与分类链接不认', async () => {
    const html = `
      <div class="posts-wrapper">
        <a href="https://www.gamer520.com/12345.html"><img src=x></a>
        <a href="https://www.gamer520.com/12345.html">绝对写法</a>
        <a href="/67890.html">相对写法</a>
        <a href="//gamer520.com/11111.html">协议相对</a>
        <a href="https://cdn.example.com/999.html">外域同形</a>
        <a href="https://www.gamer520.com/category/news">站内分类链接</a>
      </div>`
    const g = parseGamer520(html)
    const n = parseNekogal(`<a href="/archives/2024">相对</a><a href="https://www.nekogal.com/archives/2025">绝对</a>`)
    const gUrls = g.map((x) => x.url).sort()
    const pass =
      // 缩略图那条（标题为空）不能占掉 URL，否则带标题的那次被当重复跳过、结果全丢
      g.length === 3 &&
      JSON.stringify(gUrls) ===
        JSON.stringify([
          'https://gamer520.com/11111.html',
          'https://www.gamer520.com/12345.html',
          'https://www.gamer520.com/67890.html',
        ].sort()) &&
      g.find((x) => x.url.endsWith('/12345.html'))?.title === '绝对写法' &&
      n.length === 2 &&
      n.every((x) => x.url.startsWith('https://www.nekogal.com/archives/'))
    return [pass, `gamer520=${JSON.stringify(g)} nekogal=${JSON.stringify(n)}`]
  })

  // 10) 内嵌浏览器捕获到的下载，来源站点要认得全。
  //     gamers520.com（镜像页那一站，少一个 r）以前不在 matchSiteId 的名单里。
  await step('捕获链接的归属站点认得全域名', async () => {
    const cases: Array<[string, string | undefined]> = [
      ['https://www.gamer520.com/123.html', 'gamer520'],
      ['https://gamers520.com/456.html', 'gamer520'],
      ['https://pan.nekogal.top/s/abc', 'nekogal'],
      ['https://playzip.com/x', 'playzip'],
      ['https://example.com/a.bin', undefined],
      ['javascript:void(0)', undefined],
    ]
    const bad = cases.filter(([u, want]) => siteIdForUrl(u) !== want)
    return [bad.length === 0, `不匹配=${JSON.stringify(bad.map(([u, w]) => [u, siteIdForUrl(u), w]))}`]
  })

  // 11) 白屏自救：整条状态机跑一遍，用真窗口。
  //
  // 只验两件事：产物缺失时屏幕上真换成了带原因的兜底页，以及「重新加载界面」
  // 按下去真是一次导航。以前这条路上什么都没有——白屏，然后用户去开任务管理器。
  await step('白屏自救：产物缺失时出兜底页，点重载真的回到界面', async () => {
    const dir = path.join(TMP_ROOT, 'rescue')
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    const good = path.join(dir, 'good.html')
    fs.writeFileSync(
      good,
      '<!doctype html><meta charset="utf-8"><title>界面正常</title><body>界面正常</body>',
      'utf8',
    )
    let reloads = 0
    let quits = 0
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
    const r = new UiRescue({
      pageDir: dir,
      dataDir: dir,
      downloadDir: () => dir,
      getWindow: () => win,
      reloadUi: () => {
        reloads++
        void win.loadFile(good).catch(() => {})
      },
      quitApp: () => {
        quits++
      },
    })
    r.attach(win.webContents)
    try {
      await win.loadFile(path.join(dir, 'index-not-shipped.html')).catch(() => {})
      // 导航提交与 DOM 可用之间有时间差：读空了要重读，别把竞态当成产品失败。
      let text = ''
      for (let i = 0; i < 60 && !text.includes('界面'); i++) {
        if (win.webContents.getURL().endsWith(RESCUE_FILE)) {
          text = (await win.webContents.executeJavaScript(
            'document.body ? document.body.innerText : ""',
          )) as string
        }
        if (!text.includes('界面')) await new Promise((res) => setTimeout(res, 100))
      }
      const acts = text
        ? ((await win.webContents.executeJavaScript(
            "[...document.querySelectorAll('a[data-act]')].map((a) => a.dataset.act)",
          )) as string[])
        : []
      if (text) await win.webContents.executeJavaScript(`location.hash = 'reload-' + Date.now()`)
      const backToUi = await waitUntil(() => win.webContents.getURL().endsWith('good.html'), 8000)
      const pass =
        !!text &&
        text.includes('界面文件没能加载') &&
        /错误码 -\d+/.test(text) &&
        JSON.stringify(acts) === JSON.stringify(['reload', 'data', 'downloads', 'quit']) &&
        text.includes(dir) &&
        backToUi &&
        reloads === 1 &&
        quits === 0
      return [
        pass,
        `正文=${JSON.stringify(text.slice(0, 200))} 出口=${JSON.stringify(acts)} reloads=${reloads} quits=${quits} 回到界面=${backToUi} 当前=${win.webContents.getURL()}`,
      ]
    } finally {
      win.destroy()
    }
  })

  // 12) 看门狗只该拦「页面加载完了但脚本没跑起来」，绝不能把好界面换成兜底页。
  //     后半截（渲染层报了就绪就不再拦）才是这条路径的全部风险所在：判据写反的话，
  //     用户会遇到「用着用着突然跳到错误页」，比白屏更难解释。
  await step('白屏自救：看门狗只拦没挂载的界面', async () => {
    const dir = path.join(TMP_ROOT, 'rescue2')
    fs.mkdirSync(dir, { recursive: true })
    const good = path.join(dir, 'good.html')
    fs.writeFileSync(
      good,
      '<!doctype html><meta charset="utf-8"><body>界面正常</body>',
      'utf8',
    )
    const mk = (w: () => BrowserWindow | null): UiRescue =>
      new UiRescue({
        pageDir: dir,
        dataDir: dir,
        downloadDir: () => dir,
        getWindow: w,
        reloadUi: () => {},
        quitApp: () => {},
      })
    // a) 从不报 ready → 到点出兜底页，且渲染层报上来的错因要原样显示、且转义过。
    //    顺序照真实因果排：先开始加载并 arm 看门狗，页面跑起来之后才可能报错误 ——
    //    arm() 会把上一轮的诊断清空，所以「先记错因再 arm」在真实链路里不存在。
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
    const r = mk(() => win)
    r.attach(win.webContents)
    await win.loadFile(good)
    r.arm(600)
    r.noteBootError("Cannot read properties of undefined (reading 'getSettings')<script>alert(1)</script>")
    const shown = await waitUntil(() => win.webContents.getURL().endsWith(RESCUE_FILE), 6000)
    const text = shown ? ((await win.webContents.executeJavaScript('document.body.innerText')) as string) : ''
    const html = shown ? ((await win.webContents.executeJavaScript('document.documentElement.outerHTML')) as string) : ''
    // b) 立刻报 ready → 同样的时限里必须一次都不被换走
    const win2 = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
    const r2 = mk(() => win2)
    r2.attach(win2.webContents)
    await win2.loadFile(good)
    r2.arm(600)
    r2.markReady()
    await new Promise((res) => setTimeout(res, 1500))
    const stayed = win2.webContents.getURL().endsWith('good.html')
    win.destroy()
    win2.destroy()
    const hashOk =
      actionOfHash('#downloads-1737000000') === 'downloads' &&
      actionOfHash('#data') === 'data' &&
      actionOfHash('#reload') === 'reload' &&
      actionOfHash('#quit-x') === 'quit' &&
      actionOfHash('#rm -rf') === null &&
      actionOfHash('') === null
    const goneOk =
      goneReasonText('oom', 0).includes('内存') &&
      goneReasonText('crashed', 1).includes('崩溃') &&
      goneReasonText('brand-new-reason', 3).includes('brand-new-reason')
    const pass =
      shown &&
      text.includes('没有跑起来') &&
      text.includes("reading 'getSettings'") &&
      !html.includes('<script>alert(1)</script>') &&
      stayed &&
      hashOk &&
      goneOk
    return [
      pass,
      `兜底页=${shown} 正文=${JSON.stringify(text.slice(0, 160))} 注入未转义=${html.includes('<script>alert(1)</script>')} 已就绪仍拦住=${!stayed} hash/原因=${hashOk}/${goneOk}`,
    ]
  })

  // 13) 兜底页必须能被「下一次白屏」再次触发。关窗后从托盘重开是常规路径，窗口是
  //     新建的而 UiRescue 只建一次；上一轮的「正在展示」状态若不清掉，第二轮白屏
  //     就直接静默了——又回到没有出口的老样子。
  await step('白屏自救：窗口销毁重建后兜底页仍能再次出现', async () => {
    const dir = path.join(TMP_ROOT, 'rescue3')
    fs.mkdirSync(dir, { recursive: true })
    const good = path.join(dir, 'good.html')
    fs.writeFileSync(good, '<!doctype html><meta charset="utf-8"><body>界面正常</body>', 'utf8')
    // 一个实例活两轮，窗口随重建换人——和真实主进程里 rescue 只 ensure 一次一致。
    let cur: BrowserWindow | null = null
    const r = new UiRescue({
      pageDir: dir,
      dataDir: dir,
      downloadDir: () => dir,
      getWindow: () => cur,
      reloadUi: () => {},
      quitApp: () => {},
    })
    const whiteScreenRound = async (round: number): Promise<[boolean, string]> => {
      const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
      cur = w
      r.attach(w.webContents)
      await w.loadFile(good)
      // 不 markReady：等价于渲染层脚本没跑起来（preload 缺失、启动期抛错都是这样）
      r.arm(600)
      // 第一轮留一条只有它才有的诊断文本，用来查第二轮有没有把旧诊断当成本轮原因
      if (round === 1) r.noteBootError('ROUND1-STALE-DIAGNOSIS')
      const shown = await waitUntil(() => w.webContents.getURL().endsWith(RESCUE_FILE), 6000)
      const text = shown ? ((await w.webContents.executeJavaScript('document.body.innerText')) as string) : ''
      w.destroy()
      return [shown, text]
    }
    const [first, firstText] = await whiteScreenRound(1)
    const [second, secondText] = await whiteScreenRound(2)
    const noStale = firstText.includes('ROUND1-STALE-DIAGNOSIS') && !secondText.includes('ROUND1-STALE-DIAGNOSIS')
    return [
      first && second && noStale,
      `第一轮=${first} 第二轮（窗口重建后）=${second} 旧诊断不串轮=${noStale}`,
    ]
  })
}

app
  .whenReady()
  .then(main)
  .then(() => app.exit(checks.every((c) => c.pass) ? 0 : 1))
  .catch((e: unknown) => {
    process.stdout.write(
      `FD_RESULT ${JSON.stringify({ name: 'harness', pass: false, detail: String(e) })}\n`,
    )
    app.exit(2)
  })
