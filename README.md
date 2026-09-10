# FastDrop — 游戏下载盒子

把**「找游戏」**和**「下载游戏」**缝在一起的桌面应用。内置浏览器里嵌了三个游戏站点，搜出结果、选好镜像，真实直链自动进入本应用自己的下载队列——全程不离开窗口，也不用装浏览器扩展或接管系统下载。

底下是一台 **Rust 写的多线程分段下载引擎**：HTTP `Range` 切段并发、暂停/续传、崩溃后断点续传、中途改线程数不重下。引擎跑在独立进程里，和界面通过 stdio 上的换行 JSON 通信，再大的下载也不会卡住主进程的 UI。

外壳是 Electron，界面是 Vue 3 + Ant Design Vue。

## 特性

**下载引擎**

- 多线程分段下载 —— 用 HTTP `Range` 把文件切成 N 段并发拉，N 可调（默认 8）。服务器不支持 Range 时自动退回单线程。
- 暂停 / 续传 —— 暂停保留已下载的分片，续传只补缺口。
- 崩溃后断点续传 —— 每个任务旁挂 `.part.meta` 侧车文件记录各分段进度，进程被杀掉后重启接着下。
- 动态改分段数 —— 下载中途调线程数，引擎重新切段并保留已下载偏移，不重下。
- 并发上限 —— 同时最多跑几个任务可配（默认 3），超出的排队等待。
- 重试 —— 网络抖动按 1/2/4/8/16 秒退避重试，超过 5 次判失败。
- 速度 / 剩余时间 —— 滑动窗口估实时速率和 ETA。
- 任务持久化 —— 任务列表和设置存在 `~/.fastdrop/`，关窗重开还在。

**界面与设置**

- 内嵌游戏站浏览器（见下节），三站并行聚合搜索。
- 深 / 浅两套主题，主色 `#1677ff`、1px 边框 + 6px 圆角的 antd token 体系。
- 代理、User-Agent、并发数、分段数、下载目录、托盘与最小化行为均可配置。

只做 HTTP/HTTPS 直链。不支持的链接（网盘、需要登录会话的）会在 UI 里明确告诉你，并给出手动处理的入口——不假装能下。

## 快速开始

```bash
cd app && npm install
cd engine-rs && cargo build --release && cd ..
cd app && npm run dev      # 开发模式
cd app && npm run dist     # 打包安装包
```

Windows 上也可以直接双击根目录的 `run.bat`：首次运行会自动构建 Rust 引擎、装前端依赖、打包并启动应用。

前置依赖：**Rust 工具链**（构建下载引擎，必需）、**Node.js 18+ 与 npm**（前端构建与运行）。Electron 由 npm 依赖安装，打包时复用 `node_modules` 里那份发行版，不再联网去取 electron release。

## 游戏站集成

侧栏「游戏站」页签是一个内嵌浏览器，缝入 gamer520、nekogal、playzip 三个站点。用法：搜索框输关键词（三站并行搜），点结果弹出镜像列表，选一条就转成真实直链并进下载列表。

实现分三层，各站的差异集中在最薄的一层：

- **`src/main/sites/` —— 站点适配器。** 每站一个文件（`gamer520.ts` / `nekogal.ts` / `playzip.ts`），各自实现 `search` 与 `mirrors`；`registry.ts` 是唯一注册表，**加新站只改这一个文件**，主进程和渲染层都不用动。
- **`resolver.ts` —— 镜像换直链。** 能自动换的换（Cloudreve 网盘 → S3 预签名直链，分卷按 `.part1` 顺序批量入队），换不了的原样交给 UI，让用户在内嵌浏览器里手动处理。
- **`bridge.ts` —— 下载捕获。** webview 用独立会话 `persist:gamesites`，登录一次长期有效。页面上真实点击「下载」时，在 `will-download` 里 `item.cancel()` 拦掉 Electron 默认的另存为，把 URL 推给渲染层弹「添加到 FastDrop」。网盘链接是页面跳转、不触发下载，用户照常处理。

设计上的明确边界：

- **不逆向百度 / 夸克 / 迅雷的登录与签名。** 这些盘拿不到稳定的裸直链，一律回退内嵌浏览器手动处理。
- **需要 Cookie 会话的链接绝不喂给 Rust 引擎**（引擎会 4xx），只喂预签名或公开直链。
- **解析是尽力而为。** 站点 HTML 改版会让选择器失效，失败时返回可读的 `message`，UI 按 `message` 提示，不静默吞掉。

## 下载引擎工作原理

启动一个任务时，引擎先对 URL 发 `HEAD` 或 `Range: bytes=0-0` 探测，从 `Content-Range` 读真实总大小（`Content-Length` 有时不靠谱）。然后：

1. 按总大小把文件切成 N 段，每段不小于 256 KB —— 段太小调度开销大于收益。
2. 用 `set_len()` 一次性分配出和成品一样大的 `.part` 稀疏文件。
3. 每个任务 `seek()` 到自己那段偏移量开始写，各自写各自的偏移，不需要写锁。
4. 按 64 KB 一片地拉，每 100 ms 把 `.part.meta` 侧车文件落盘（先写 `.tmp` 再 rename，原子替换）。
5. 全部分段完成，`.part` 改名成目标文件，删除侧车。

`.part.meta` 里是每段的已完成字节数，续传时只补缺口。每次开始下载都会换一个 generation，上一轮残留的 worker 看到代际变化就自己退出——所以暂停恢复时不会出现两个 worker 同时写同一段。

下面几个坑是靠测试发现的，不是读代码看出来的：

- **每段起步都必须 seek**，不能只在有续传偏移时才 seek。`start` 对第一段之外的每段都是非零值，漏掉这一步会让所有段都写到偏移 0 互相覆盖。
- **每次重试前都要重新 seek。** 上一次尝试可能写了一部分就失败，文件位置已经越过了段起点。
- **要 Range 却收到 200 就必须失败。** 服务器忽略了 Range 会开始推整个文件，按段偏移写进去就是损坏。
- **写入不能越过段边界。** 一个 chunk 可能比剩余空间大，要截断。

进度不是等分段下完才报的：每个分段在下载过程中就把已落盘字节数漏进一个原子计数器，worker 每 100 ms 折算一次推进快照。慢连接上一段可能跑几分钟，只在下完时汇报的话进度条会一直停在原地；崩溃也一样——按分段边界记账会丢掉整整一段的工作，按段内偏移记账才能精确续传。

## 引擎与界面的通信

换行分隔的 JSON。界面往里发命令：

```json
{"cmd":"probe","url":"...","dest":"...","threads":8}
{"cmd":"run"}
{"cmd":"pause"}
{"cmd":"stop"}
{"cmd":"set_threads","n":16}
```

引擎往外发事件：

```json
{"event":"progress","data":{...快照...}}
{"event":"done","total":104857600}
{"event":"error","error":"..."}
```

`probe` 和 `run` 是两条命令：`probe` 只算出分段和续传偏移，状态停在 `idle`；`run` 才真正开始。

## 目录结构

```
app/                 Electron 外壳 + Vue 前端
  src/main/          主进程：引擎子进程桥（engine.ts）、调度（manager.ts）、持久化（store.ts）
    sites/           游戏站集成：站点注册表、各站适配器、直链解析、下载捕获桥
  src/preload/       preload：把接口暴露为 window.fd
  src/renderer/      Vue 3 + Ant Design Vue：AppShell / TaskRow / SettingsDialog ...
    components/      含 GameSites.vue（内嵌浏览器页签）
  src/shared/        主进程与渲染进程共享的类型和 IPC 频道名
  electron-builder.yml   打包配置：把引擎打进 resources/
engine-rs/           Rust 下载引擎（独立二进制，无界面）
  src/main.rs        分段并发下载 + sidecar 续传 + stdio JSON 协议
tests/               引擎回归测试
```

`engine.ts` 起引擎子进程、收发 JSON 事件；`manager.ts` 负责并发调度、排队和重试。

引擎是独立二进制，打包后作为普通文件落在 `resources/fastdrop-engine.exe`——不能进 asar（asar 里 spawn 不了子进程），`enginePath()` 按 `process.resourcesPath` 找它。漏配这一项，打包后的应用启动正常、一点下载才报「Rust 引擎未找到」。

## 开发与测试

```bash
# Rust 引擎：4 个用例（分段并发 / 不支持 Range 回退 / 断点续传 / 错误上报）
python tests/test_engine_rs.py

# 前端类型检查 + 生产构建
cd app && npm run typecheck && npm run build
```

测试脚本自带本地 HTTP 服务器（支持 Range 与不支持 Range 两个端口），不碰外网。所有下载用例都做 **md5 全量校验**，不是只看「下载完成了」。暂停/续传用例里终端会刷一堆 `ConnectionAbortedError`——那是测试服务器侧收到客户端主动断连的正常噪音，不是失败。

UI 侧走真实验证：用 CDP（Chrome DevTools Protocol）连渲染进程读 DOM，再检查数据目录里落盘的 JSON。亮/暗两套配色数值、Modal、Tabs 切换、以及打包后 `resources/` 里的引擎能否被找到，都是实测过的。

游戏站集成同样走真实验证：用 CDP 连打包产物的渲染进程，确认 preload 接口齐全、`<webview>` 真触发 `dom-ready`，并跑通完整链路——nekogal 详情 → golink 解码 → Cloudreve 列目录 → S3 预签名直链（4 分卷、顺序正确）。验证一律用隔离的 `--user-data-dir`，不碰真实的 `~/.fastdrop`。

## 许可

MIT
