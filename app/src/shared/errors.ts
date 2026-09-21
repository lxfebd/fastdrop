/**
 * 错误文案的用户侧翻译层。
 *
 * 引擎（engine-rs）与主进程报上来的字符串是英文的技术描述，例如
 * `http 403`、`truncated: got 3 of 4000000 bytes`、`os error 112`。它们对写代码的人
 * 够用，对「只是想把这个游戏下完」的人等于没说——用户看到的是一行红字和一个继续转圈
 * 的进度条，不知道是该等、该重试，还是该回站点重新点一次下载。
 *
 * 所以这里把每条错误拆成两句话：
 *   title  —— 发生了什么（放在任务行副标题里，必须短）
 *   advice —— 用户下一步做什么（放在详情卡和系统通知里）
 *
 * 只认得出的一律回落 `unknownTitle`，并且永远保留原文：翻译是为了让人看懂，
 * 不是为了把信息藏起来。排查问题时还是要能看到引擎原话。
 */

export interface ErrorExplanation {
  /** 一句话说明发生了什么，不含技术黑话 */
  title: string
  /** 用户下一步该做什么。空串表示无需额外提示 */
  advice: string
  /** 引擎/主进程的原始文案 */
  raw: string
}

const UNKNOWN_TITLE = '下载中断'

/** 顺序敏感：更具体的模式必须排在前面（先 "on every attempt" 再裸 "ignored Range"）。 */
const rules: { test: RegExp; title: string; advice: string }[] = [
  // ---- 链接本身的凭据/有效期问题（galgame 站最常见的失败） ----
  { test: /\bhttp (401|403)\b/, title: '服务器拒绝访问（需要登录或链接已过期）', advice: '回到游戏站重新点一次下载，别用复制的旧链接。' },
  { test: /\bhttp 404\b/, title: '链接指向的文件不存在了', advice: '这个直链已经失效，回站点换一个镜像重新下载。' },
  { test: /\bhttp 410\b/, title: '资源已被站点删除', advice: '换一个下载源。' },
  { test: /\bhttp 429\b/, title: '被站点限速了（短时间请求太多）', advice: '等几分钟再点重试，或者先把并发任务数调低。' },
  { test: /\bhttp 416\b/, title: '服务器兑现不了它声明的字节区间', advice: '这条链接不稳定，换一个镜像重试。' },
  { test: /\bhttp 4[0-9]{2}\b/, title: '站点拒绝了这次请求', advice: '回游戏站重新点一次下载；持续如此说明这个镜像不可用。' },
  { test: /\bhttp 5[0-9]{2}\b/, title: '站点服务器出错', advice: '多半是对方临时故障，过一会儿点重试。' },

  // ---- Range / 分段能力协商（引擎侧自愈，但仍要让人看懂） ----
  { test: /range request on every attempt/i, title: '这台服务器不支持分段下载', advice: '把线程数调到 1 再重试即可正常下载。' },
  { test: /ignored range/i, title: '服务器无视了分段请求', advice: '引擎会自动退回单线程续传，稍等即可。' },
  { test: /range not starting at/i, title: '服务器返回的数据段和请求对不上', advice: '为防止写坏文件已中止，点重试会重新校验。' },

  // ---- 传输中断 ----
  { test: /truncated.*every attempt|server truncated/i, title: '服务器每次都少发数据，链接不可靠', advice: '换一台镜像重新下载，这里重试通常没用。' },
  { test: /truncated/i, title: '传到一半被掐断了', advice: '网络或站点不稳定，会自动重连续传。' },
  { test: /did not reply within/i, title: '服务器迟迟不响应', advice: '对方过载或你已断网，检查网络后点重试。' },
  { test: /read timeout/i, title: '连接长时间没有数据', advice: '站点速度慢或掉线，会自动重试。' },

  // ---- 内容完整性（字节都到齐了，但不是那份文件） ----
  { test: /checksum mismatch/i, title: '文件内容和站点给的校验和对不上', advice: '下下来的不是服务器那一份：常见于代理/加速节点改了内容，或站点自己换了文件。请用「重新下载」换一个镜像，别用「继续」——继续只会把同一份错的东西接着下完。已下载的文件保留在原处。' },
  { test: /unsupported checksum|unknown checksum/i, title: '这个校验和算法引擎认不出来', advice: '目前支持 MD5 / SHA-1 / SHA-256。把任务里的校验和改成其中一种（或直接贴十六进制串）再重试。' },

  // ---- 解析 / 目标文件 ----
  { test: /no file size/i, title: '服务器不肯告诉文件多大', advice: '这种链接会按单线程整份下载，进度条只显示已下大小、没有百分比，属正常现象。' },
  { test: /os error 112|not enough space|no space left|磁盘空间不足/i, title: '磁盘空间不足', advice: '清理磁盘或把下载目录换到空间更大的盘，再点「继续下载」——已下好的部分会接着用，不会重下。' },
  { test: /os error 5\b|permission denied|access denied/i, title: '没有权限写入目标位置（或文件正被占用）', advice: '关掉正在使用该文件的程序，或把下载目录换到一个可写的位置。' },
  { test: /os error 36|name too long/i, title: '文件路径太长，系统放不下', advice: '把下载目录改到更浅的路径，例如 D:\\games。' },
  { test: /os error 123|invalid (argument|data)|filename/i, title: '文件名或路径不合法', advice: '新建任务时手动改一下保存的文件名。' },
  { test: /rename failed/i, title: '下完了但没能改成正式文件名', advice: '目标文件正被占用（比如杀毒软件在扫），关掉它再点重试。' },
  { test: /seek failed/i, title: '断点位置写不进文件', advice: '删掉本任务的半截文件后重新下载。' },
  { test: /open part/i, title: '打不开临时下载文件', advice: '检查下载目录是否可写、磁盘是否满了。' },

  // ---- 网络与地址 ----
  // 代理相关的两种来源都要认：引擎报 `invalid proxy url`（填的串 reqwest 解析不了），
  // 主进程报「代理配置没能生效」（系统代理解析失败）。都不该被兜底成「下载中断」。
  { test: /invalid proxy url|代理配置没能生效|proxy url/i, title: '代理设置没能生效', advice: '打开设置 → 网络，检查代理地址（例：http://127.0.0.1:7890）。清空则跟随系统代理。' },
  { test: /dns|failed to lookup|name (does not|resolution)/i, title: '域名解析不了（地址写错或 DNS 故障）', advice: '确认链接是否完整；换了网络就重试。' },
  { test: /connection refused|tcp connect error|connect failure|client::connect|TcpStream::connect/i, title: '连不上服务器（或代理没开）', advice: '换镜像或稍后重试；如果设置里填了代理，先确认代理进程真的在跑。' },
  { test: /certificate|invalid peer|i\/o error.*tls|ssl/i, title: 'HTTPS 证书校验没过', advice: '站点证书有问题或被网关劫持，确认网络环境后重试。' },
  { test: /too many redirects|redirect|302\b/i, title: '链接反复跳转，取不到文件', advice: '这种地址需要登录态，请在浏览器里登录该站后重新点下载。' },
  { test: /\bhttp 3\d{2}\b/, title: '链接反复跳转，取不到文件', advice: '这种地址通常需要登录态，请在浏览器里登录后重新下载。' },
  { test: /error sending request|error decoding response body|connection closed|connection reset|broken pipe|connection reset by peer|io error/i, title: '网络传输中断', advice: '会自动重连续传；持续失败就换个网络再试。' },

  // ---- 引擎自身（几乎只可能是打包/进程问题） ----
  { test: /bad json|unknown cmd|stdin read error/i, title: '下载引擎通信异常', advice: '重启 FastDrop。如果每次都是这样，请把日志 ~/.fastdrop/.engine-stderr.log 发给开发者。' },
  { test: /engine .* not found|未找到.*引擎/i, title: '没有安装下载引擎', advice: '这份安装包缺 fastdrop-engine.exe，请重新安装完整版本。' },
]

/** 把原始错误翻译成用户看得懂的两句话。空错误返回 null（表示没有错误）。 */
export function explainError(raw: string | null | undefined): ErrorExplanation | null {
  const text = String(raw ?? '').trim()
  if (!text) return null
  for (const r of rules) {
    if (r.test.test(text)) return { title: r.title, advice: r.advice, raw: text }
  }
  // 兜底也要有 advice：未知错误最有用的一句就是「先重试，不行再看原文」。
  return { title: UNKNOWN_TITLE, advice: '点「重试」再下一次；一直失败请把下面这行原文发给开发者。', raw: text }
}

/** 任务行副标题用的短句式：只说发生了什么，放得下才谈建议。 */
export function errorLine(raw: string | null | undefined): string {
  const e = explainError(raw)
  return e ? e.title : ''
}
