# FastDrop

一个**多线程分段下载管理器**——复刻的是 IDM 的*功能*（分片并发、暂停/续传、崩溃后断点续传），不是它的界面。界面用 **Ant Design v5** 的 token 体系重做：`#1677ff` 主色、`#f5f5f5` 画布、白色卡片配 1px 边框、6px 圆角、8px 栅格；任务行子行直接展示剩余时间/线程数/完成时刻，空态引导新建下载。

只做 HTTP/HTTPS。不打包浏览器扩展、不接管系统下载，就是一个干净的任务列表。

下载引擎是 **Rust** 写的，跑在独立进程里；界面是 Python + PySide6。两者用 stdio 上的换行 JSON 通信。这样重下载不会占用 GIL，UI 才不会卡。找不到 Rust 引擎时自动退回内置的 Python 实现，功能不变，只是慢一些。

## 快速开始

```bash
python -m pip install -r requirements.txt
cd engine-rs && cargo build --release && cd ..
python fastdrop/main.py
```

或者直接双击 `run.bat`（Windows，首次运行会自动装依赖并构建引擎）。没有 Rust 工具链也没关系——应用会退回 Python 引擎，功能完整。

命令行直接丢 URL 进去会立即开始下载：

```bash
python fastdrop/main.py https://example.com/big.iso
```

## 功能

- **多线程分段下载** —— 用 HTTP `Range` 把文件切成 N 段并发拉，N 可调（默认 8）。服务器不支持 Range 时自动退回单线程。
- **暂停 / 续传** —— 暂停保留已下载的分片；续传只补还没完成的段。
- **崩溃后断点续传** —— 每个任务旁挂一个 `.part.meta` 侧车文件记录各分段进度，进程被杀掉后重启能接着下，不用从头再来。
- **动态改分段数** —— 下载中途调线程数，引擎重新切段并保留已下载偏移，不重下。
- **并发上限** —— 同时最多跑几个任务可配（默认 3），超出的排队等待。
- **重试** —— 网络抖动按 1/2/4/8/16 秒退避重试，超过 5 次判失败。
- **速度 / 剩余时间** —— 按滑动窗口估实时速率和 ETA。
- **任务持久化** —— 任务列表和设置存在 `~/.fastdrop/`，关窗重开还在。
- 系统托盘、深/浅主题、代理、User-Agent 均可配置。

## 目录结构

```
fastdrop/            界面层（PySide6）
  main.py            入口
  ui_main.py         主窗口：侧栏 / 任务列表 / 详情面板
  widgets.py         通用组件，含分段进度条
  dialogs.py         新建下载 / 设置 / 关于
  theme.py           Ant Design v5 设计 token、中文字体栈、图标渲染
  tray.py            系统托盘
  assets/            Lucide 风格 SVG 图标（33 个）
idm/                 调度层（不依赖 Qt）
  engine.py          DownloadTask：内置 Python 引擎，Rust 不可用时的兜底
  engine_rs.py       RustTask：子进程桥，起引擎进程、收发 JSON 事件
  manager.py         Manager：引擎选择、并发调度、队列、快照
  models.py          TaskDef / Settings / Store 持久化
engine-rs/           Rust 下载引擎（独立二进制，无界面）
  src/main.rs        分段并发下载 + sidecar 续传 + stdio JSON 协议
tests/               引擎测试 + 桥接测试 + UI 离屏验证
```

`engine_rs` 和 `engine.py` 对外接口一致（`state`/`speed`/`snapshot`/`run`/`pause`/`resume`/`stop`），所以 Manager 和 UI 不关心用的是哪个。引擎选在 `manager.py` 里一处决定。

## 工作原理

启动一个任务时，引擎先对 URL 发 `HEAD`/`Range: bytes=0-0` 探测，从 `Content-Range` 读真实总大小（`Content-Length` 有时不靠谱）。然后：

1. 按总大小把文件切成 N 段，每段不小于 256 KB（段太小调度开销大于收益）。
2. 用 `set_len()` 一次性分配出和成品一样大的 `.part` 稀疏文件。
3. 每个任务 `seek()` 到自己那段偏移量开始写——各自写各自的偏移，不需要写锁。
4. 按 64 KB 一片地拉，每 100 ms 把 `.part.meta` 侧车文件落盘（先写 `.tmp` 再 rename，原子替换）。
5. 全部分段完成，`.part` 改名成目标文件，删除侧车。

`.part.meta` 里是每段的已完成字节数，续传时只补缺口。每次开始下载都会换一个 generation，上一轮残留的工作任务看到代际变化就自己退出——所以暂停恢复时不会出现两个任务同时写同一段。

几个容易踩的坑，都是靠测试才发现的，不是靠读代码看出来的：

- **每段起步都必须 seek**，不能只在有续传偏移时才 seek。`start` 对第一段之外的每段都是非零值，漏掉这一步会让所有段都写到偏移 0 互相覆盖。
- **每次重试前都要重新 seek**。上一次尝试可能写了一部分就失败，文件位置已经越过了段起点。
- **要 Range 却收到 200 就必须失败**。服务器忽略了 Range 会开始推整个文件，按段偏移写进去就是损坏。
- **写入不能越过段边界**。一个 chunk 可能比剩余空间大，要截断。

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

`probe` 和 `run` 是两条命令：`probe` 只算出分段和续传偏移，状态停在 `idle`；`run` 才真正开始。侧车文件是 Rust 和 Python 两个引擎共用的同一套格式，所以换引擎不会丢进度。

进度不是等分段下完才报的：每个分段在下载过程中就把已落盘的字节数漏进一个原子计数器，worker 每 100ms 折算一次推进快照。慢连接上一段可能跑几分钟，如果只在下完时汇报，那段时间进度条会一直停在原地；崩溃也一样——按分段边界记账会丢掉整整一段的工作，按段内偏移记账则能精确续传。

## 测试

```bash
# Rust 引擎：4 个用例（分段并发 / 不支持 Range 回退 / 断点续传 / 错误上报）
python tests/test_engine_rs.py

# 桥接 + 调度：5 个用例（引擎可用 / 快照字段 / 暂停续传 / Manager 全链路 / 引擎接入）
python tests/test_bridge.py

# 内置 Python 引擎：7 个用例（基础下载 / 暂停续传 / 连续两次续传 / 冷启动续传 / 单线程兜底 / 坏 URL / 分段布局）
python tests/test_engine.py

# UI：离屏渲染验证主窗口、三个对话框、主题切换
QT_QPA_PLATFORM=offscreen python tests/verify.py
```

前三个都自带本地 HTTP 服务器（支持 Range 和不支持 Range 两个端口），不碰外网。所有下载用例都用 **md5 全量校验**，不是只看"下载完成了"。暂停/续传用例里终端会刷一堆 `ConnectionAbortedError`——那是测试服务器侧收到客户端主动断连的正常噪音，不是失败。

另外有 `tests/_net_verify.py` 走真实公网（Hetzner / OVH / tele2 等候选源，遇到限流会自动换源重试）：urllib 单线程先下基准算 md5，再让 Rust 引擎 8 段并发比对、杀掉进程模拟崩溃后从侧车续传比对、最后 Python 引擎下同一个文件做跨引擎互验。崩溃续传用本地限速服务器造"确定的中途中断"，而不是赌公网慢下来。

当前状态：**Rust 引擎 4/4、桥接 5/5、Python 引擎 7/7、UI 离屏验证、真实公网 4/4 全部通过**。

## 依赖

- Python 3.10+
- PySide6（Qt 6，唯一第三方依赖）
- Rust（可选，只为更快；缺失时用内置 Python 引擎）

## 许可

自用/学习项目。图标基于 Lucide 风格重绘，`assets/` 内的 SVG 可自由使用。
