//! FastDrop engine — a standalone async download process the UI drives over stdio.
//!
//! Protocol: newline-delimited JSON, one message per line, both directions.
//!
//!   stdin   {"cmd":"probe","url":...,"dest":...,"threads":8,"proxy":"","user_agent":""}
//!           {"cmd":"run"} {"cmd":"pause"} {"cmd":"resume"} {"cmd":"stop"}
//!           {"cmd":"set_threads","n":16} {"cmd":"stats"}
//!
//!   stdout  {"event":"progress","data":{...snapshot...}}   (every 100 ms while downloading)
//!           {"event":"done","total":N}
//!           {"event":"error","error":"..."}
//!
//! Segment offsets and the `.part.meta` sidecar keep the same format across engine
//! versions, so resume data written by an older version still works.

use std::io::{SeekFrom, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::TryStreamExt;
use reqwest::header::HeaderValue;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncSeekExt, AsyncWriteExt, BufReader, Stdout, stdin, stdout};
use tokio::sync::Mutex;

const CHUNK: u64 = 64 * 1024;
const MIN_SEGMENT: u64 = 256 * 1024;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
/// TCP + TLS + 发请求的耗时上限。**不能**用 reqwest 的 `.timeout()`——那个覆盖
/// 的是整个请求含读完响应体的总时长，任何超过 45s 的健康慢速下载都会被准时
/// 掐断（实测：数据稳定流入中报 error decoding response body）。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// 从发请求到拿到响应头的上限。`.connect_timeout()` 只管 TCP/TLS 握手，
/// 不管服务端处理时长，所以还得单独兜这一层。
const HEADERS_TIMEOUT: Duration = Duration::from_secs(30);
/// 整个探测（HEAD，失败则退回一次带 Range 的 GET）的总预算。必须比 `HEADERS_TIMEOUT`
/// 宽一些，因为 `.send()` 的耗时包含 TCP/TLS 握手（`CONNECT_TIMEOUT` 15s），那段是从
/// 30s 里扣的；留 10s 余量才不会让外层先超时、把内层的原因信息吞掉。
const PROBE_TIMEOUT: Duration = Duration::from_secs(40);
/// 相邻两段数据之间的空闲上限。真正判定「服务端死了」的开关，取代旧的整请求
/// 超时——慢但健康的传输可以一直跑，只有真的卡住才断。
const CHUNK_IDLE: Duration = Duration::from_secs(60);
/// 指数退避封顶。重试次数不再封顶：下载任务应该无限重连，断多久都能续上。
const RETRY_BACKOFF_CAP: u64 = 30;
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

#[derive(Default, Serialize, Deserialize)]
struct Segment {
    index: usize,
    start: u64,
    end: u64,
    downloaded: u64,
    status: String,
    speed: f64,
}

impl Segment {
    fn new(index: usize, start: u64, end: u64) -> Self {
        Self { index, start, end, downloaded: 0, status: "waiting".into(), speed: 0.0 }
    }
    fn size(&self) -> u64 {
        self.end - self.start + 1
    }
    fn done(&self) -> bool {
        self.downloaded >= self.size()
    }
    fn seg_progress(&self) -> f64 {
        if self.size() == 0 { 0.0 } else { (self.downloaded as f64 / self.size() as f64).min(1.0) }
    }
}

struct Task {
    url: String,
    dest: String,
    threads: usize,
    total: u64,
    ranges_ok: bool,
    state: String,
    error: String,
    speed: f64,
    segments: Vec<Segment>,
    client: reqwest::Client,
    paused: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
    /// 每次 run 递增。被取消的 worker 看到代际变化就退出，避免恢复时
    /// 出现两个 worker 同时写同一段。
    gen: usize,
}

struct FetchErr {
    msg: String,
    fatal: bool,
}

impl Task {
    fn tmp_path(&self) -> String {
        format!("{}.part", self.dest)
    }
    fn sidecar_path(&self) -> String {
        format!("{}.part.meta", self.dest)
    }

    fn build_segments(&mut self) {
        let n = self.threads.max(1);
        let step = self.total / n as u64;
        self.segments.clear();
        for i in 0..n {
            let start = i as u64 * step;
            let end = if i == n - 1 { self.total - 1 } else { start + step - 1 };
            self.segments.push(Segment::new(i, start, end));
        }
        if let Some(saved) = self.load_sidecar() {
            // Resume offsets are only meaningful if the layout is identical.
            let layout_ok = saved.get("url").and_then(|v| v.as_str()) == Some(self.url.as_str())
                && saved.get("total").and_then(|v| v.as_u64()) == Some(self.total)
                && saved.get("threads").and_then(|v| v.as_u64()) == Some(n as u64);
            if layout_ok {
                if let Some(segs) = saved.get("segments").and_then(|v| v.as_object()) {
                    for s in &mut self.segments {
                        let key = s.index.to_string();
                        let got = segs.get(&key).and_then(|v| v.as_u64()).unwrap_or(0);
                        s.downloaded = got.min(s.size());
                    }
                }
            }
        }
    }

    fn save_sidecar(&self) {
        let mut m = serde_json::Map::new();
        for s in &self.segments {
            m.insert(s.index.to_string(), json!(s.downloaded));
        }
        let obj = json!({
            "url": self.url, "total": self.total,
            "threads": self.segments.len(), "segments": m,
        });
        let tmp = format!("{}.tmp", self.sidecar_path());
        if let Ok(mut f) = std::fs::File::create(&tmp) {
            if f.write_all(obj.to_string().as_bytes()).is_ok() {
                let _ = f.sync_all();
                let _ = std::fs::rename(&tmp, self.sidecar_path());
            }
        }
    }

    fn load_sidecar(&self) -> Option<Value> {
        let txt = std::fs::read_to_string(self.sidecar_path()).ok()?;
        serde_json::from_str(&txt).ok()
    }

    /// Allocate the full-size sparse `.part` once. Each segment then opens its own
    /// handle and writes only its own byte range, so no write locking is needed.
    async fn ensure_part(&self) -> Result<(), String> {
        let p = self.tmp_path();
        if let Some(parent) = Path::new(&p).parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
        }
        let f = tokio::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(&p)
            .await
            .map_err(|e| e.to_string())?;
        let len = tokio::fs::metadata(&p).await.map(|m| m.len()).unwrap_or(0);
        if len != self.total {
            f.set_len(self.total).await.map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn downloaded(&self) -> u64 {
        self.segments.iter().map(|s| s.downloaded).sum()
    }
    fn progress(&self) -> f64 {
        if self.total == 0 { 0.0 } else { (self.downloaded() as f64 / self.total as f64).min(1.0) }
    }
    fn eta(&self) -> f64 {
        let rem = self.total as f64 - self.downloaded() as f64;
        if self.total == 0 || rem <= 0.0 {
            return 0.0;
        }
        if self.speed <= 1.0 {
            return -1.0;
        }
        rem / self.speed
    }
    fn all_done(&self) -> bool {
        self.segments.iter().all(|s| s.done())
    }
    fn any_error(&self) -> bool {
        self.segments.iter().any(|s| s.status == "error")
    }

    fn snapshot(&self) -> Value {
        let filename = Path::new(&self.dest)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        json!({
            "url": self.url,
            "dest": self.dest,
            "filename": filename,
            "total": self.total,
            "downloaded": self.downloaded(),
            "progress": self.progress(),
            "speed": self.speed,
            "eta": self.eta(),
            "state": self.state,
            "error": self.error,
            "threads": self.segments.len(),
            "segments": self.segments.iter().map(|s| json!({
                "index": s.index, "progress": s.seg_progress(),
                "status": s.status, "speed": s.speed, "size": s.size(),
            })).collect::<Vec<_>>(),
        })
    }
}

#[derive(Deserialize, Default)]
struct Cmd {
    #[serde(default)] cmd: String,
    #[serde(default)] url: String,
    #[serde(default)] dest: String,
    #[serde(default)] threads: usize,
    #[serde(default)] proxy: String,
    #[serde(default)] user_agent: String,
    #[serde(default)] n: usize,
}

fn make_client(proxy: &str, user_agent: &str) -> reqwest::Client {
    let mut b = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .http2_adaptive_window(true);
    if !proxy.is_empty() {
        if let Ok(p) = reqwest::Proxy::all(proxy) {
            b = b.proxy(p);
        }
    }
    let mut h = reqwest::header::HeaderMap::new();
    let ua = if user_agent.is_empty() { USER_AGENT } else { user_agent };
    if let Ok(ua) = HeaderValue::from_str(ua) {
        h.insert("User-Agent", ua);
    }
    b.default_headers(h).build().expect("http client")
}

/// 发请求并等响应头，单独封顶 `HEADERS_TIMEOUT`。
///
/// 不能用 reqwest 的 `.timeout()`：它把「读完整个响应体」也算进去，会掐断健康的
/// 慢速下载。拆成「连接」「响应头」两段各自的短截止 + 正文靠 `CHUNK_IDLE` 空闲
/// 检测，才既不误杀慢传输，也不会在永远不吐头的服务器上卡死。
async fn send_headers(
    req: reqwest::RequestBuilder,
    deadline: Duration,
) -> Result<reqwest::Response, FetchErr> {
    match tokio::time::timeout(deadline, req.send()).await {
        Ok(r) => r.map_err(|e| FetchErr { msg: e.to_string(), fatal: true }),
        Err(_) => Err(FetchErr {
            msg: format!("server did not reply within {}s", deadline.as_secs()),
            fatal: false,
        }),
    }
}

/// `Accept-Ranges` is a *response* header, so echoing it in the request proves
/// nothing. Issue one 1-byte range request and require a real `206`.
async fn check_ranges(client: &reqwest::Client, url: &str) -> bool {
    match send_headers(client.get(url).header("Range", "bytes=0-0"), HEADERS_TIMEOUT).await {
        Ok(resp) => {
            let st = resp.status().as_u16();
            let acc = resp
                .headers()
                .get("Accept-Ranges")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.eq_ignore_ascii_case("bytes"))
                .unwrap_or(false);
            drop(resp);
            st == 206 || acc
        }
        Err(_) => false,
    }
}

/// Total size via HEAD, falling back to a ranged GET when HEAD is refused.
/// Both legs share ONE `PROBE_TIMEOUT` budget instead of each carrying their own
/// `HEADERS_TIMEOUT` — without that, a hung HEAD followed by a hung GET stacks to
/// twice the deadline. The fallback is also skipped when HEAD merely timed out:
/// a server that never answers HEAD won't answer GET, so the second leg just burns
/// the whole remaining budget for nothing.
/// Total size via HEAD, falling back to a ranged GET when HEAD is unusable.
/// Both legs share ONE `PROBE_TIMEOUT` budget: the fallback gets whatever the first
/// leg left, so the total can't stack past the deadline. The fallback is skipped
/// entirely when HEAD just timed out — a host that never answers HEAD won't answer
/// GET either, so the second leg would only burn the remaining budget for nothing.
async fn probe_total(client: &reqwest::Client, url: &str) -> Result<u64, String> {
    fn total_from(resp: &reqwest::Response) -> Option<u64> {
        let cr = resp.headers().get("Content-Range").and_then(|v| v.to_str().ok()).map(str::to_owned);
        let cd = resp.headers().get("Content-Length").and_then(|v| v.to_str().ok()).map(str::to_owned);
        cr.as_deref().and_then(|s| s.rsplit_once('/'))
            .and_then(|(_, t)| t.trim().parse::<u64>().ok())
            .or_else(|| cd.as_deref().and_then(|s| s.parse::<u64>().ok()))
            .filter(|&t| t > 0)
    }

    let started = Instant::now();
    let head = send_headers(client.head(url), PROBE_TIMEOUT).await;
    let resp = match head {
        // HEAD answered successfully: use it directly.
        Ok(r) if r.status().is_success() => r,
        // HEAD timed out: the host isn't going to answer a ranged GET either.
        Err(FetchErr { fatal: false, .. }) => return Err("server did not reply".to_string()),
        // HEAD answered but wasn't usable (403/405), or send failed. Some servers
        // refuse HEAD outright, so give a ranged GET the rest of the budget.
        _ => {
            let remaining = PROBE_TIMEOUT.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                return Err(format!("server did not reply within {}s", PROBE_TIMEOUT.as_secs()));
            }
            match send_headers(client.get(url).header("Range", "bytes=0-0"), remaining).await {
                Ok(r) => r,
                Err(e) => return Err(e.msg),
            }
        }
    };
    total_from(&resp).ok_or_else(|| "server returned no file size".to_string())
}

/// Fetch one contiguous range and stream it straight into `file`.
/// Returns how many bytes were written; 0 means "no progress".
/// Reports the segment-relative offset as bytes arrive. The counter starts at
/// `base` so the worker can read it directly instead of adding deltas.
type OnProgress = Option<(Arc<AtomicU64>, u64)>;

/// 状态码里哪些重试也没意义。416 意味着请求的区间已经越界（客户端算错了偏移
/// 或文件被改了），再重试只是把同一请求重放 N 次，必须停下来。
fn is_fatal_status(st: u16) -> bool {
    matches!(st, 401 | 403 | 404 | 410 | 416)
}

/// 服务器声明的分片大小：优先取 `Content-Range` 的区间长度，退回 `Content-Length`。
/// 用来判断「服务器提前断了连接」——只读到 60% 就返回 200 是常见的坑。
fn declared_len(resp: &reqwest::Response) -> Option<u64> {
    let cr = resp
        .headers()
        .get("Content-Range")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split('=').nth(1))
        .and_then(|r| r.split('-').next())
        .and_then(|a| a.split('-').next())
        .and_then(|a| a.trim().parse::<u64>().ok());
    cr.or_else(|| resp.content_length())
}

async fn fetch_and_write(
    client: &reqwest::Client,
    url: &str,
    from: u64,
    end: u64,
    size: u64,
    file: &mut tokio::fs::File,
    ranges_ok: bool,
    on_progress: OnProgress,
) -> Result<u64, FetchErr> {
    let resp = send_headers(
        client.get(url).header("Range", format!("bytes={from}-{end}")),
        HEADERS_TIMEOUT,
    )
    .await?;
    let st = resp.status().as_u16();
    if !(resp.status().is_success() || st == 206) {
        return Err(FetchErr {
            msg: format!("http {st}"),
            fatal: is_fatal_status(st),
        });
    }
    // When we asked for a range and got 200, the server ignored the range and
    // is streaming the whole file. Writing that at our offset would corrupt
    // the file, so fail non-fatally and let the caller retry / fall back.
    if ranges_ok && st != 206 {
        return Err(FetchErr {
            msg: "server ignored Range request".into(),
            fatal: false,
        });
    }
    let expect = declared_len(&resp).unwrap_or(size);
    let mut stream = resp.bytes_stream();
    let mut written = 0u64;
    let mut remaining = end - from + 1;
    loop {
        if remaining == 0 {
            break;
        }
        // `timeout` wraps the stream item in `Ok`, so the match is on that outer layer.
        match tokio::time::timeout(CHUNK_IDLE, stream.try_next()).await {
            Ok(Ok(Some(bytes))) => {
                if bytes.is_empty() {
                    continue;
                }
                // Cap each write so long segments still report progress in small steps,
                // and never write past the end of this segment.
                let mut pos = 0usize;
                while pos < bytes.len() {
                    let room = remaining as usize;
                    if room == 0 {
                        break;
                    }
                    let chunk = ((pos + CHUNK as usize).min(bytes.len()) - pos).min(room);
                    file.write_all(&bytes[pos..pos + chunk]).await
                        .map_err(|e| FetchErr { msg: e.to_string(), fatal: true })?;
                    written += chunk as u64;
                    remaining -= chunk as u64;
                    pos += chunk;
                    if let Some((p, base)) = &on_progress {
                        // 段内累计偏移，worker 直接读。`base` 是本次尝试前
                        // 已完成的量，fetch 任务里不改 `done`，避免两处竞争。
                        p.store(base + written, Ordering::Relaxed);
                    }
                }
            }
            Ok(Ok(None)) => {
                // 流正常结束。字节数对不上就是服务器提前断链，必须重试：
                // 否则 worker 会以为这一段完了，把残缺的 `.part` rename 成成品。
                if written < expect {
                    return Err(FetchErr {
                        msg: format!("truncated: got {written} of {expect} bytes"),
                        fatal: false,
                    });
                }
                break;
            }
            Ok(Err(e)) => {
                // 流中途炸了。能走到这里说明响应头已经拿到、body 已经开始传，所以
                // 「声明的字节数没给够」就是截断——reqwest 对这种情况报的是
                // `error decoding response body` 而不是干净 EOF，两种都得算。
                // 少一个字节和整个 body 都没送来对重试策略没有区别：都是服务端
                // 没兑现它自己声明的长度。真正连不上会走 `send_headers` 的分支。
                if written < expect {
                    return Err(FetchErr {
                        msg: format!("truncated: got {written} of {expect} bytes"),
                        fatal: false,
                    });
                }
                return Err(FetchErr { msg: e.to_string(), fatal: false });
            }
            Err(_) => {
                return Err(FetchErr { msg: "read timeout".into(), fatal: false });
            }
        }
    }
    Ok(written)
}

/// Drive one segment to completion. Only the worker holding `gen` writes it.
async fn worker(task: Arc<Mutex<Task>>, index: usize, gen: usize) {
    let (client, url, part, ranges_ok, paused, cancelled) = {
        let g = task.lock().await;
        (
            g.client.clone(),
            g.url.clone(),
            g.tmp_path(),
            g.ranges_ok,
            g.paused.clone(),
            g.cancelled.clone(),
        )
    };

    let mut file = match tokio::fs::OpenOptions::new().read(true).write(true).open(&part).await {
        Ok(f) => f,
        Err(e) => {
            let mut g = task.lock().await;
            if g.gen == gen {
                if let Some(s) = g.segments.get_mut(index) {
                    s.status = "error".into();
                }
                g.error = format!("open part: {e}");
            }
            return;
        }
    };

    let (start, end, size, initial) = {
        let g = task.lock().await;
        let Some(s) = g.segments.get(index) else { return };
        (s.start, s.end, s.size(), s.downloaded)
    };
    let mut done = initial;

    // 必须先 seek 到本段起点：`start` 对第一段之外的每段都是非零值，
    // 漏掉这一步会让所有段都写到偏移 0 互相覆盖。
    if file.seek(SeekFrom::Start(start + initial)).await.is_err() {
        let mut g = task.lock().await;
        if g.gen == gen {
            if let Some(s) = g.segments.get_mut(index) {
                s.status = "error".into();
            }
            g.error = "seek failed".into();
        }
        return;
    }

    let mut attempt = 0usize;
    // 连续截断次数，单独计数：`attempt` 成功就会归零，但截断是累积证据。
    let mut trunc_streak: u32 = 0;
    let mut interval_start = Instant::now();
    let mut interval_bytes = 0u64;

    while done < size {
        if cancelled.load(Ordering::Relaxed) {
            return;
        }
        {
            let g = task.lock().await;
            if g.gen != gen {
                return;
            }
        }

        // 暂停：在这里停住。恢复时 run() 先换代再清 pause 标志，
        // 所以唤醒后看到的必然不是自己的代际，随即退出。
        if paused.load(Ordering::Relaxed) {
            tokio::time::sleep(Duration::from_millis(50)).await;
            continue;
        }

        let from = start + done;
        // 每次尝试前重新 seek：上一次尝试可能写了一部分就失败，文件位置已越过 `from`。
        if file.seek(SeekFrom::Start(from)).await.is_err() {
            let mut g = task.lock().await;
            if g.gen == gen {
                if let Some(s) = g.segments.get_mut(index) {
                    s.status = "error".into();
                }
                g.error = "seek failed".into();
            }
            return;
        }

        // 下载期间也要报进度：`fetch_and_write` 跑完整个段才返回，慢连接上一段
        // 可能要几分钟，只等它返回会让 UI 那段时间一直停在 0%，崩溃也会丢掉
        // 整整一段的工作。写盘结果通过原子计数器漏出来，这里每个 tick 折算。
        let (progress_cb, counter) = {
            let g = task.lock().await;
            if g.gen != gen {
                return;
            }
            let c = Arc::new(AtomicU64::new(0));
            c.store(done, Ordering::Relaxed);
            (Some((c.clone(), done)), c)
        };
        let fut = fetch_and_write(
            &client, &url, from, end, size, &mut file, ranges_ok, progress_cb,
        );
        tokio::pin!(fut);
        let mut progress = tokio::time::interval(PROGRESS_INTERVAL);
        let outcome;
        loop {
            tokio::select! {
                r = &mut fut => { outcome = r; break; }
                _ = progress.tick() => {
                    if cancelled.load(Ordering::Relaxed) {
                        return;
                    }
                    let live = counter.load(Ordering::Relaxed);
                    if live > done {
                        interval_bytes += live - done;
                        done = live;
                    }
                    if interval_bytes > 0 {
                        let el = interval_start.elapsed().as_secs_f64().max(0.001);
                        let spd = interval_bytes as f64 / el;
                        interval_start = Instant::now();
                        interval_bytes = 0;
                        let mut g = task.lock().await;
                        if g.gen == gen {
                            if let Some(s) = g.segments.get_mut(index) {
                                s.downloaded = done.min(size);
                                s.speed = spd;
                            }
                        }
                    }
                }
            }
        }

        // fetch 结束后可能还没走到下一个 tick，先把计数器的终值折进 `done`。
        // 否则下一轮会按旧的 `from` 重新请求同一段，把同一段写两遍。
        let final_live = counter.load(Ordering::Relaxed);
        if final_live > done {
            interval_bytes += final_live - done;
            done = final_live;
        }

        match outcome {
            Ok(_) => {
                attempt = 0;
                let mut g = task.lock().await;
                if g.gen == gen {
                    if let Some(s) = g.segments.get_mut(index) {
                        s.downloaded = done.min(size);
                        s.speed = 0.0;
                    }
                    // 重试成功后清掉刚才那条错误提示；但如果别的段还在报错就留着，
                    // 别把别人正在失败的信号一起抹掉。
                    if !g.any_error() {
                        g.error = String::new();
                    }
                }
            }
            Err(e) => {
                if e.fatal {
                    let mut g = task.lock().await;
                    if g.gen == gen {
                        if let Some(s) = g.segments.get_mut(index) {
                            s.status = "error".into();
                        }
                        g.error = e.msg;
                    }
                    return;
                }
                // 可恢复的错误也必须让 UI 看见：以前这里只有 fatal 分支会写
                // `g.error`，于是断线、截断这些还在重试的情况 UI 一直是空白的，
                // 用户根本不知道发生了什么。写成「最近一次错误」而不是终态——
                // tick 判定终态靠的是段的 `status`，不是 `g.error`，所以这里写
                // 了不会把任务翻成 error 态，进度照常推送。
                let mut g = task.lock().await;
                if g.gen == gen {
                    g.error = e.msg.clone();
                }
                drop(g);
                // 网络抖动会自愈，无限重试是对的。但截断是服务端「每次都少发」
                // 的确定性行为——重试一万次也只会得到同样的残缺结果。所以截断
                // 连续出现就升级成 fatal，让状态落到 error 并停止空转。2 次足以
                // 排除偶发断链：真正会截断的服务器对每次请求都给同样的残缺结果。
                const MAX_TRUNCATION: u32 = 2;
                let trunc_streak = if e.msg.starts_with("truncated") {
                    trunc_streak += 1;
                    trunc_streak
                } else {
                    trunc_streak = 0;
                    0
                };
                if trunc_streak >= MAX_TRUNCATION {
                    let mut g = task.lock().await;
                    if g.gen == gen {
                        if let Some(s) = g.segments.get_mut(index) {
                            s.status = "error".into();
                        }
                        g.error = format!("{}: server truncated every attempt", e.msg);
                    }
                    return;
                }
                // 无限重试：下载任务该断多久就能续多久。
                attempt += 1;
                // 指数退避封顶 30s。抖动故意只往下走（80%..100%）而不是上下抖——
                // 抖动超过封顶就失去意义了。8 个 worker 若同时重试会一起把服务器
                // 压死，所以按 attempt×7 + index×13 做确定性伪随机，避免引 rand。
                let base = (1u64 << attempt.min(5)).min(RETRY_BACKOFF_CAP);
                let phase = ((attempt * 7 + index * 13) % 5) as u64;
                let jitter = 80 + phase * 5; // 80%..100%
                let wait = base * jitter / 100;
                tokio::time::sleep(Duration::from_secs(wait.max(1))).await;
            }
        }
    }

    let mut g = task.lock().await;
    if g.gen == gen {
        if let Some(s) = g.segments.get_mut(index) {
            s.downloaded = s.size();
            s.speed = 0.0;
            s.status = "done".into();
        }
    }
}

/// 删除 `.part` 与 sidecar 并把偏移归零。stop 的语义是放弃下载。
async fn discard_progress(g: &mut Task) {
    let _ = tokio::fs::remove_file(&g.tmp_path()).await;
    let _ = tokio::fs::remove_file(&g.sidecar_path()).await;
    for s in &mut g.segments {
        s.downloaded = 0;
        s.speed = 0.0;
        s.status = "waiting".into();
    }
}

async fn spawn_workers(task: Arc<Mutex<Task>>, gen: usize) {
    let pending: Vec<usize> = {
        let g = task.lock().await;
        g.segments.iter().filter(|s| !s.done()).map(|s| s.index).collect()
    };
    for index in pending {
        {
            let mut g = task.lock().await;
            if let Some(s) = g.segments.get_mut(index) {
                s.status = "running".into();
            }
        }
        tokio::spawn(worker(task.clone(), index, gen));
    }
}

/// Move `.part` to the final name and drop the sidecar.
async fn finalize(g: &Task) -> Option<Value> {
    if let Some(parent) = Path::new(&g.dest).parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    if tokio::fs::rename(&g.tmp_path(), &g.dest).await.is_ok() {
        let _ = tokio::fs::remove_file(&g.sidecar_path()).await;
        Some(json!({"event":"done","total":g.total}))
    } else {
        Some(json!({"event":"error","error":"rename failed"}))
    }
}

async fn emit_line(out: &mut tokio::io::BufWriter<Stdout>, v: Value) {
    let _ = out.write_all((v.to_string() + "\n").as_bytes()).await;
    let _ = out.flush().await;
}

async fn handle(
    cmd: Cmd,
    task: &mut Option<Arc<Mutex<Task>>>,
    out: &mut tokio::io::BufWriter<Stdout>,
) {
    match cmd.cmd.as_str() {
        "probe" => {
            let _ = emit_line(out, json!({"event":"progress","data":{"state":"preparing"}})).await;
            let client = make_client(&cmd.proxy, &cmd.user_agent);
            let total = match probe_total(&client, &cmd.url).await {
                Ok(t) => t,
                Err(e) => {
                    let _ = emit_line(out, json!({"event":"error","error":e})).await;
                    return;
                }
            };
            let ranges_ok = check_ranges(&client, &cmd.url).await;
            let threads = if ranges_ok {
                cmd.threads.max(1).min((total / MIN_SEGMENT).max(1) as usize)
            } else {
                1
            };
            let mut t = Task {
                url: cmd.url.clone(),
                dest: cmd.dest.clone(),
                threads,
                total,
                ranges_ok,
                state: "idle".into(),
                error: String::new(),
                speed: 0.0,
                segments: Vec::new(),
                client,
                paused: Arc::new(AtomicBool::new(false)),
                cancelled: Arc::new(AtomicBool::new(false)),
                gen: 0,
            };
            t.build_segments();
            let snap = t.snapshot();
            let _ = emit_line(out, json!({"event":"progress","data":snap})).await;
            *task = Some(Arc::new(Mutex::new(t)));
        }
        "run" | "resume" => {
            if let Some(t) = task.clone() {
                if let Err(e) = t.lock().await.ensure_part().await {
                    let _ = emit_line(out, json!({"event":"error","error":e})).await;
                    return;
                }
                {
                    let mut g = t.lock().await;
                    // 必须先换代、再清 pause：反过来的话，还在 park 的旧 worker
                    // 会把 pause 清掉当成自己该继续跑，和新 worker 一起写同一段。
                    g.gen += 1;
                    g.cancelled.store(false, Ordering::Relaxed);
                    g.paused.store(false, Ordering::Relaxed);
                    g.state = "downloading".into();
                    g.error = String::new();
                }
                let _ = emit_line(out, json!({"event":"progress","data":t.lock().await.snapshot()})).await;
                let gen = t.lock().await.gen;
                spawn_workers(t.clone(), gen).await;
            }
        }
        "pause" => {
            if let Some(t) = task.clone() {
                let mut g = t.lock().await;
                g.paused.store(true, Ordering::Relaxed);
                for s in &mut g.segments {
                    if s.status == "running" {
                        s.status = "paused".into();
                    }
                }
                g.state = "paused".into();
                g.save_sidecar();
                let _ = emit_line(out, json!({"event":"progress","data":g.snapshot()})).await;
            }
        }
        "stop" => {
            if let Some(t) = task.clone() {
                let mut g = t.lock().await;
                // stop 是“不保留进度”：除了让 worker 退出，还要清掉 sidecar
                // 和已记录的分段偏移，否则下一次 run 会从半路接着下。
                g.gen += 1;
                g.cancelled.store(true, Ordering::Relaxed);
                g.paused.store(true, Ordering::Relaxed);
                g.state = "idle".into();
                g.error = String::new();
                g.speed = 0.0;
                discard_progress(&mut g).await;
                let _ = emit_line(out, json!({"event":"progress","data":g.snapshot()})).await;
            }
        }
        "set_threads" => {
            if let Some(t) = task.clone() {
                let mut g = t.lock().await;
                if g.total > 0 && g.ranges_ok && g.state != "downloading" {
                    let new_n = cmd.n.max(1).min((g.total / MIN_SEGMENT).max(1) as usize);
                    if new_n != g.threads {
                        // 先记下老布局，重切之后按字节偏移重新摊回新段，
                        // 否则换线程数会把已经下载的进度清零。
                        let old_segs: Vec<(u64, u64, u64)> = g.segments
                            .iter().map(|x| (x.start, x.end, x.downloaded)).collect();
                        g.threads = new_n;
                        g.build_segments();
                        if !old_segs.is_empty() {
                            for seg in &mut g.segments {
                                let mut got = 0u64;
                                for &(ostart, oend, odone) in &old_segs {
                                    let lo = seg.start.max(ostart);
                                    let hi = seg.end.min(oend);
                                    if lo > hi {
                                        continue;
                                    }
                                    let overlap = hi - lo + 1;
                                    let have = odone.min(overlap);
                                    if have == 0 {
                                        break;
                                    }
                                    got += have;
                                }
                                seg.downloaded = got.min(seg.size());
                                seg.status = if seg.done() { "done" } else { "waiting" }.into();
                            }
                        }
                        g.save_sidecar();
                    }
                }
                let _ = emit_line(out, json!({"event":"progress","data":g.snapshot()})).await;
            }
        }
        "stats" => {
            if let Some(t) = task.clone() {
                let _ = emit_line(out, json!({"event":"progress","data":t.lock().await.snapshot()})).await;
            }
        }
        other => {
            let _ = emit_line(out, json!({"event":"error","error":format!("unknown cmd: {other}")})).await;
        }
    }
}

/// Read one line from stdin into `buf`. `read_line` is used instead of
/// `lines().next_line()` because the iterator produced by `lines()` is a
/// temporary that dies before `select!` can poll it.
async fn read_stdin_line(
    reader: &mut BufReader<tokio::io::Stdin>,
    buf: &mut String,
) -> Option<String> {
    buf.clear();
    match reader.read_line(buf).await {
        Ok(0) => None,
        Ok(n) => Some(buf[..n].trim().to_string()),
        Err(_) => None,
    }
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let mut task: Option<Arc<Mutex<Task>>> = None;
    let mut last_downloaded: u64 = 0;
    let mut last_speed_at = Instant::now();

    let mut reader = BufReader::new(stdin());
    let mut line_buf = String::new();
    let mut out = tokio::io::BufWriter::new(stdout());
    let mut tick = tokio::time::interval(PROGRESS_INTERVAL);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            line = read_stdin_line(&mut reader, &mut line_buf) => {
                let line = match line {
                    Some(t) if !t.is_empty() => t,
                    Some(_) => continue,
                    None => break,
                };
                let cmd = match serde_json::from_str::<Cmd>(&line) {
                    Ok(c) => c,
                    Err(e) => {
                        let msg = json!({"event":"error","error":format!("bad json: {e}")});
                        let _ = out.write_all((msg.to_string() + "\n").as_bytes()).await;
                        let _ = out.flush().await;
                        continue;
                    }
                };
                handle(cmd, &mut task, &mut out).await;
            }
            _ = tick.tick() => {
                if let Some(t) = &task {
                    let st = {
                        let g = t.lock().await;
                        (g.state.clone(), g.downloaded())
                    };
                    if st.0 != "downloading" {
                        continue;
                    }
                    // EMA of overall speed across the tick interval.
                    let el = last_speed_at.elapsed().as_secs_f64().max(0.001);
                    let inst = (st.1 - last_downloaded) as f64 / el;
                    let mut g = t.lock().await;
                    g.speed = if g.speed <= 0.0 { inst } else { g.speed * 0.7 + inst * 0.3 };
                    let mut finish_msg = None;
                    if g.any_error() {
                        g.state = "error".into();
                        finish_msg = Some(json!({"event":"error","error":g.error}));
                    } else if g.all_done() {
                        g.state = "done".into();
                        let msg = finalize(&g).await;
                        finish_msg = msg;
                    } else {
                        g.save_sidecar();
                    }
                    last_downloaded = st.1;
                    last_speed_at = Instant::now();
                    let snap = g.snapshot();
                    drop(g);
                    let _ = out.write_all((json!({"event":"progress","data":snap}).to_string() + "\n").as_bytes()).await;
                    if let Some(m) = finish_msg {
                        let _ = out.write_all((m.to_string() + "\n").as_bytes()).await;
                    }
                    let _ = out.flush().await;
                }
            }
        }
    }
    Ok(())
}
