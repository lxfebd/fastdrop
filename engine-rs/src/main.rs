//! FastDrop engine — a standalone async download process the UI drives over stdio.
//!
//! Protocol: newline-delimited JSON, one message per line, both directions.
//!
//!   stdin   {"cmd":"probe","url":...,"dest":...,"threads":8,"proxy":"","user_agent":"",
//!            "rate_limit_kbps":0,"checksum":""}
//!           {"cmd":"run"} {"cmd":"pause"} {"cmd":"resume"} {"cmd":"stop"}
//!           {"cmd":"set_threads","n":16} {"cmd":"stats"}
//!           {"cmd":"set_rate","rate_limit_kbps":512}
//!
//!   stdout  {"event":"progress","data":{...snapshot...}}   (every 100 ms while downloading)
//!           {"event":"done","total":N}
//!           {"event":"error","error":"..."}
//!
//! Snapshot keys: url, dest, filename, total, downloaded, progress, speed, eta, state,
//! error, threads, segments, **verifying**, **rate_limit_kbps**.
//!
//! `rate_limit_kbps` is KiB/s shared by every segment of the task (aria2's
//! `--max-download-limit` semantics), 0 = unlimited. `checksum` is `"sha256:<hex>"` /
//! `"sha1:<hex>"` / `"md5:<hex>"` (prefix case-insensitive; a bare 64-hex string means
//! sha256) and is verified over the finished `.part` right before the rename.
//!
//! `set_threads` and `set_rate` each answer with one fresh snapshot — there is no
//! separate ack event. `{"cmd":"run"}`/`{"cmd":"resume"}` may also carry
//! `rate_limit_kbps`/`checksum`, and a bare `{"cmd":"run"}` keeps whatever probe set.
//! While `total == 0` (unknown length) `progress` and `eta` stay 0 and `threads` is 1.
//! During verification `verifying` is true while `state` stays "downloading"; the
//! terminal snapshot is always emitted **before** `done`/`error`.
//!
//! Segment offsets and the `.part.meta` sidecar keep the same format across engine
//! versions, so resume data written by an older version still works. Unknown-length
//! downloads (no `Content-Length`, no `206`) never send `Range` and cannot be resumed.

use std::io::{SeekFrom, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::TryStreamExt;
use reqwest::header::HeaderValue;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Digest;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufReader, Stdout, stdin, stdout};
use tokio::sync::{Mutex, mpsc};

const CHUNK: u64 = 64 * 1024;
const MIN_SEGMENT: u64 = 256 * 1024;
/// 单次 `throttle()` 最多睡这么久就重新看一次桶。限速值随时可被 `set_rate` 改，
/// 一口气睡「补齐整段所需的时间」会把调高/取消限速拖成没反应；极低限速下
/// （比如 1 KiB/s）这也能让写盘保持小步推进，而不是一停几十秒。
const THROTTLE_WAIT_CAP: Duration = Duration::from_millis(50);
/// 校验和时一次读多少字节。只走一遍顺序读，靠系统页缓存，代价很小。
const HASH_BUF: usize = 128 * 1024;
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
/// 引擎是长驻进程：每次 `probe` 建一个新任务并领一个递增代号。后台校验等异步结果
/// 必须带着这个代号回来，主循环只接受「当前任务」的结果，否则上一轮任务会把
/// 新任务的终态盖掉（跨任务串味）。
static NEXT_TASK_ID: AtomicU64 = AtomicU64::new(1);

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
}

/// 线程数变了、段重新切分后，新段 `[ns, ne]` 里到底有多少字节是「真的已经下过了」。
/// 关键：老段真正下载的字节区间是 `[ostart, ostart+odone)`，把它和新段求交集长度才是
/// 真实已有的量。老段之间的下载区间互不相交，所以逐段相加不会重复计数。
/// 旧算法累加 `min(odone, overlap)`，隐含假设老段已下载的字节都落在重叠区间的开头，
/// 会把整段重叠区都当成已下载，凭空多出进度——这正是「中途改线程数导致文件损坏」的根因。
/// 纯函数，便于单元测试。
fn recompute_segment(ns: u64, ne: u64, old: &[(u64, u64, u64)]) -> u64 {
    let new_excl = ne.saturating_add(1);
    let mut got = 0u64;
    for &(ostart, oend, odone) in old {
        // 老段真实已下载区间 [ostart, oexcl)，钳到本老段末尾以内。
        let oexcl = ostart.saturating_add(odone).min(oend.saturating_add(1));
        let lo = ns.max(ostart);
        let hi = new_excl.min(oexcl);
        if hi > lo {
            got += hi - lo;
        }
    }
    got.min(ne - ns + 1)
}

// ---------------------------------------------------------------- 限速（令牌桶）

/// KiB/s → 字节/秒。字段名叫 `rate_limit_kbps`，单位按 1024 算（和 UI 上的 KB/s 一致）。
fn rate_bps(kbps: u64) -> u64 {
    kbps.saturating_mul(1024)
}

/// 桶容量（= 允许的突发量），单位字节。取 ~100ms 的配额：
/// 再大限速就形同虚设（起手能突发好几秒的量），再小则唤醒过密、写盘碎片化。
/// 纯函数，便于单元测试。
fn bucket_capacity(limit_bps: u64) -> u64 {
    if limit_bps == 0 { 0 } else { (limit_bps / 10).max(1) }
}

/// `elapsed` 时间内按 `limit_bps` 能补多少令牌（字节）。纯函数，便于单元测试。
/// 用微秒做中间单位：1 KiB/s 下 1ms 只值 1 字节，用毫秒会把低速档整体算成 0。
fn refill_tokens(limit_bps: u64, elapsed: Duration) -> u64 {
    (elapsed.as_micros() as u64).saturating_mul(limit_bps) / 1_000_000
}

/// 一个任务内所有分段共享的令牌桶。**不是**每段各限一份：
/// 8 段并发时总速度仍受同一个上限约束（aria2 `--max-download-limit` 的语义）。
#[derive(Debug)]
struct Bucket {
    /// 字节/秒。0 = 不限速（此时 `tokens` 恒 0，`throttle` 直接放行）。
    limit_bps: u64,
    /// 当前可用令牌（字节），上限见 `bucket_capacity`。
    tokens: u64,
    /// 上次补令牌的时刻。
    last: Instant,
}

impl Bucket {
    fn new(limit_kbps: u64) -> Self {
        Self { limit_bps: rate_bps(limit_kbps), tokens: 0, last: Instant::now() }
    }

    /// 按流逝时间补令牌，钳在容量以内。
    fn refill(&mut self) {
        let now = Instant::now();
        let elapsed = now.saturating_duration_since(self.last);
        self.last = now;
        if self.limit_bps == 0 {
            self.tokens = 0;
            return;
        }
        let cap = bucket_capacity(self.limit_bps);
        self.tokens = self.tokens.saturating_add(refill_tokens(self.limit_bps, elapsed)).min(cap);
    }

    /// 运行中改限速（含调回 0 取消）。先结算旧速率攒下的令牌，再重置计时起点，
    /// 否则「刚调高」要等到下一次长时间流逝才见效。
    fn set_limit(&mut self, limit_kbps: u64) {
        self.refill();
        self.limit_bps = rate_bps(limit_kbps);
        self.last = Instant::now();
        self.tokens = self.tokens.min(bucket_capacity(self.limit_bps));
    }
}

/// 想写 `want` 字节，问桶要配额。返回**本次可以立即写入**的字节数（<= `want`，
/// 不限速时就是 `want`），不足的部分调用方下一轮再要——所以调用方必须按返回值写，
/// 别把自己算的 `want` 全写下去。
///
/// 锁只在算令牌的那一小段持有，`sleep` 期间不放着锁，所以多个 worker 是真并发地
/// 从同一个桶里扣配额。
async fn throttle(bucket: &Arc<Mutex<Bucket>>, want: u64) -> u64 {
    if want == 0 {
        return 0;
    }
    loop {
        let (grant, wait) = {
            let mut b = bucket.lock().await;
            if b.limit_bps == 0 {
                return want;
            }
            b.refill();
            if b.tokens > 0 {
                let g = b.tokens.min(want);
                b.tokens -= g;
                (g, None)
            } else {
                // 一个令牌都没有：等出至少 1 字节配额，最长 `THROTTLE_WAIT_CAP`。
                let cap_us = THROTTLE_WAIT_CAP.as_micros() as u64;
                let micros = (1_000_000u64 / b.limit_bps.max(1)).clamp(1, cap_us);
                (0, Some(Duration::from_micros(micros)))
            }
        };
        if grant > 0 {
            return grant;
        }
        tokio::time::sleep(wait.unwrap_or(THROTTLE_WAIT_CAP)).await;
    }
}

// ---------------------------------------------------------------- 校验和

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Alg {
    Sha256,
    Sha1,
    Md5,
}

impl Alg {
    fn label(self) -> &'static str {
        match self {
            Alg::Sha256 => "sha256",
            Alg::Sha1 => "sha1",
            Alg::Md5 => "md5",
        }
    }
    fn hex_len(self) -> usize {
        match self {
            Alg::Sha256 => 64,
            Alg::Sha1 => 40,
            Alg::Md5 => 32,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Checksum {
    alg: Alg,
    /// 小写十六进制。
    hex: String,
}

impl Checksum {
    fn display(&self) -> String {
        format!("{}:{}", self.alg.label(), self.hex)
    }
}

/// 解析 `"sha256:<hex>"` / `"sha1:<hex>"` / `"md5:<hex>"`（前缀大小写不敏感，
/// 也接受 `sha-256`/`sha-1` 写法），裸 64 位十六进制按 sha256 处理。
/// 空串 → `Ok(None)`（不校验，不做任何额外磁盘读）。
/// 纯函数，便于单元测试。
fn parse_checksum(raw: &str) -> Result<Option<Checksum>, String> {
    let s = raw.trim();
    if s.is_empty() {
        return Ok(None);
    }
    let (alg, hex) = match s.split_once(':') {
        Some((name, hex)) => {
            let a = match name.trim().to_ascii_lowercase().as_str() {
                "sha256" | "sha-256" => Alg::Sha256,
                "sha1" | "sha-1" => Alg::Sha1,
                "md5" => Alg::Md5,
                other => return Err(format!("unsupported checksum algorithm: {other}")),
            };
            (a, hex.trim())
        }
        // 裸十六进制只认 sha256 的长度；其余一律要求写前缀，免得把 32 位 md5
        // 猜成 sha1 之类，校验个寂寞。
        None => {
            if s.len() == Alg::Sha256.hex_len() {
                (Alg::Sha256, s)
            } else {
                return Err(format!(
                    "checksum needs an algorithm prefix (sha256:/sha1:/md5:), got {} hex digits",
                    s.len()
                ));
            }
        }
    };
    if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("{} checksum is not hexadecimal: {hex}", alg.label()));
    }
    if hex.len() != alg.hex_len() {
        return Err(format!(
            "{} checksum must be {} hex digits, got {}",
            alg.label(),
            alg.hex_len(),
            hex.len()
        ));
    }
    Ok(Some(Checksum { alg, hex: hex.to_ascii_lowercase() }))
}

/// 一遍顺序读把文件哈希出来。
///
/// 逐字节 `format!("{b:02x}")` 而不是 `{:x}` 打 `Output`：后者要求
/// `GenericArray` 实现 `LowerHex`，而那需要给 `D::OutputSize` 加一堆关联类型约束，
/// 换算法时每次都要重写。这里一次哈希一个文件，性能差异可以忽略。
async fn hash_file<D: Digest + Send>(path: &str) -> Result<String, String> {
    let mut f = tokio::fs::File::open(path).await.map_err(|e| format!("{path}: {e}"))?;
    let mut hasher = D::new();
    let mut buf = vec![0u8; HASH_BUF];
    loop {
        let n = f.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// 后台校验的产物：`error` 为 None 表示通过，否则是给用户看的整句错误。
struct VerifyResult {
    task_id: u64,
    gen: usize,
    error: Option<String>,
}

async fn digest_file(cs: &Checksum, path: &str) -> Result<String, String> {
    match cs.alg {
        Alg::Sha256 => hash_file::<sha2::Sha256>(path).await,
        Alg::Sha1 => hash_file::<sha1::Sha1>(path).await,
        Alg::Md5 => hash_file::<md5::Md5>(path).await,
    }
}

/// 起一次校验。三种结果都要变成可读文案：通过 / 不一致（保留文件不删）/ 读盘失败。
async fn run_verify(cs: Checksum, path: String, task_id: u64, gen: usize, tx: mpsc::UnboundedSender<VerifyResult>) {
    let error = match digest_file(&cs, &path).await {
        Ok(actual) => {
            if actual == cs.hex {
                None
            } else {
                Some(format!(
                    "checksum mismatch: expected {}, got {}:{}",
                    cs.display(),
                    cs.alg.label(),
                    actual
                ))
            }
        }
        Err(e) => Some(format!("checksum verify failed: {e}")),
    };
    let _ = tx.send(VerifyResult { task_id, gen, error });
}

struct Task {
    url: String,
    dest: String,
    threads: usize,
    total: u64,
    ranges_ok: bool,
    /// 长度未知：探测拿不到任何 `Content-Length`/`Content-Range`（典型是流式接口，
    /// chunked 传输）。走单流顺序下载，永不发 `Range`，也不支持断点续传。
    unknown_len: bool,
    /// 未知长度流已读到 EOF。此时 `total` 已被置为真实写入字节数。
    /// 单独记这个是因为 `total == 0` 阶段段没有确定边界，不能靠 `Segment::done()` 判完成，
    /// 否则写进第一个字节就会「全段完成」→ 半截文件被 rename 成成品。
    stream_done: bool,
    /// 完成后校验和（None = 不校验，完全不读盘）。
    checksum: Option<Checksum>,
    /// 正在做 rename 前的校验。快照里回传给 UI 显示「校验中」，`state` 仍是 downloading。
    verifying: bool,
    /// 当前限速（KiB/s，0 = 不限速）。只为快照回显，真正生效的状态在 `rate` 里。
    rate_kbps: u64,
    /// 本任务所有分段共享的一个令牌桶（aria2 `--max-download-limit` 语义）。
    rate: Arc<Mutex<Bucket>>,
    /// 任务代号：`probe` 每次换新任务都递增。用来丢弃上一轮任务的异步结果
    /// （后台校验），避免引擎长驻时跨任务串味。
    id: u64,
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
    /// 服务器无视了 Range 请求（本次 from>0）。这类错误「原地重试」毫无意义——
    /// 每次都会拿到整份文件。worker 收到它要把该段 `done` 归零、重新 seek 到段首，
    /// 从段首（对单段任务即偏移 0）重下才能自愈，而不是空转。
    restart_from_zero: bool,
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
        if self.unknown_len {
            // 长度未知：只有一条流，段的真边界要等 EOF 才知道（见 `worker_stream`）。
            // 这里放一个占位段，让快照的 threads 恒为 1，并且**不读边车**——
            // 长度未知的下载不支持断点续传。
            self.threads = 1;
            self.segments.push(Segment::new(0, 0, 0));
            return;
        }
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
    ///
    /// 续传前必须校验 `.part` 的真实状态，而不是盲信边车：文件若是新建的、或 `set_len`
    /// 之前长度不等于 `total`（老版本残留、磁盘截断、被外部删过/改过），边车记的偏移
    /// 就可能是「说下过了、文件里其实是空洞」。这两种情况都把本任务所有段的
    /// `downloaded` 归零并重写边车，从头下。反过来，只有「文件已存在且长度正好等于
    /// total」才认定边车可信、保留进度——真实续传（首跑就 set_len 到 total）永远满足，
    /// 所以不会误清进度。
    ///
    /// 长度未知（`unknown_len`）时**绝不能 `set_len`**：此时 `total` 是 0（或上一轮读到
    /// 的旧长度），`set_len(0)` 会把手上正在写的文件直接截断。而且长度未知无法校验
    /// `.part` 里已有的前缀属于同一份内容（服务器换了文件、或上一轮只写了半截都看不出来），
    /// 所以这条路径不支持断点续传：偏移一律清零，从 0 重下。
    async fn ensure_part(&mut self) -> Result<(), String> {
        let p = self.tmp_path();
        if let Some(parent) = Path::new(&p).parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
        }
        let meta_before = tokio::fs::metadata(&p).await.ok();
        let existed = meta_before.is_some();
        let before = meta_before.map(|m| m.len()).unwrap_or(0);
        let f = tokio::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(&p)
            .await
            .map_err(|e| e.to_string())?;
        if !self.unknown_len && before != self.total {
            f.set_len(self.total).await.map_err(|e| e.to_string())?;
        }
        let after = f.metadata().await.map(|m| m.len()).unwrap_or(0);
        drop(f);
        // 只有「本来就存在」且「改长度前已经是 total」才叫完好，可信任边车进度。
        let intact = !self.unknown_len && existed && before == self.total && after == self.total;
        if !intact {
            for s in &mut self.segments {
                s.downloaded = 0;
                s.speed = 0.0;
                s.status = "waiting".into();
            }
            self.stream_done = false;
            self.save_sidecar();
        }
        Ok(())
    }

    /// 改限速（KiB/s，0 = 取消）。桶锁是叶子锁（`throttle` 从不跨 await 持锁），
    /// 所以可以安全地在持有任务锁时 await 它。
    async fn set_rate(&mut self, kbps: u64) {
        self.rate_kbps = kbps;
        self.rate.lock().await.set_limit(kbps);
    }

    /// 快照里给 UI 看的段大小。长度未知且还没读到 EOF 时段没有确定边界，
    /// 报 0 比报占位值（1 字节）诚实。
    fn seg_size(&self, s: &Segment) -> u64 {
        if self.unknown_len && self.total == 0 { 0 } else { s.size() }
    }
    fn seg_progress(&self, s: &Segment) -> f64 {
        let sz = self.seg_size(s);
        if sz == 0 { 0.0 } else { (s.downloaded as f64 / sz as f64).min(1.0) }
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
        if self.unknown_len {
            // 未知长度的段没有确定边界（占位段 size 为 1），写进一个字节就会 `done()`。
            // 所以完成与否只看「流是否读到 EOF」，否则半截 .part 会被 rename 成成品。
            return self.stream_done;
        }
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
            // 校验中：state 仍是 downloading，主进程据此显示「校验中」。
            // 不校验/其他时候恒为 false。
            "verifying": self.verifying,
            "rate_limit_kbps": self.rate_kbps,
            "segments": self.segments.iter().map(|s| json!({
                "index": s.index, "progress": self.seg_progress(s),
                "status": s.status, "speed": s.speed, "size": self.seg_size(s),
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
    /// 限速，单位 KiB/s，0 = 不限速。`probe` / `run` / `set_rate` 都接受。
    /// 用 `Option` 是为了区分「JSON 里没这个字段」和「显式给 0」：前者**不改**当前限速，
    /// 否则一条裸 `{"cmd":"run"}` 就会把 probe 设好的限速抹成不限速。
    /// 对调用方没有额外负担——写 `"rate_limit_kbps": 512` 即可，和普通数字完全一样。
    #[serde(default)] rate_limit_kbps: Option<u64>,
    /// 完成后校验和，空 = 不校验（不产生任何额外磁盘读）。
    /// 形如 `"sha256:<hex>"` / `"sha1:<hex>"` / `"md5:<hex>"`，裸 64 位十六进制按 sha256 处理。
    #[serde(default)] checksum: String,
}

fn make_client(proxy: &str, user_agent: &str) -> Result<reqwest::Client, String> {
    let mut b = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .http2_adaptive_window(true);
    // 代理串解析不了必须当场报错，不能 `if let Ok(..)` 静默跳过：跳过等于用户填了
    // 代理却一路直连，失败时他会去怀疑站点，而真正的原因是那行配置根本没生效。
    if !proxy.is_empty() {
        let p =
            reqwest::Proxy::all(proxy).map_err(|e| format!("invalid proxy url: {proxy} ({e})"))?;
        b = b.proxy(p);
    }
    let mut h = reqwest::header::HeaderMap::new();
    let ua = if user_agent.is_empty() { USER_AGENT } else { user_agent };
    if let Ok(ua) = HeaderValue::from_str(ua) {
        h.insert("User-Agent", ua);
    }
    b.default_headers(h)
        .build()
        .map_err(|e| format!("http client build failed: {e}"))
}

/// reqwest 错误的 `to_string()` 只有最外层那句 `error sending request for url (...)`，
/// 真正的病因（`tcp connect error` / `Connection refused`）藏在 source 链里。
/// 界面是按这些关键词决定「连不上服务器」还是「网络传输中断，会自动重连」的：
/// 代理地址填错时若只给外层，用户会以为站点在抽风，等一台根本没挂的站自愈。
fn req_err(e: &reqwest::Error) -> String {
    let mut msg = e.to_string();
    let mut src = std::error::Error::source(e);
    while let Some(s) = src {
        msg.push_str(": ");
        msg.push_str(&s.to_string());
        src = s.source();
    }
    msg
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
        Ok(r) => r.map_err(|e| FetchErr { msg: req_err(&e), fatal: true, restart_from_zero: false }),
        Err(_) => Err(FetchErr {
            msg: format!("server did not reply within {}s", deadline.as_secs()),
            fatal: false,
            restart_from_zero: false,
        }),
    }
}

/// `Accept-Ranges` is a *response* header, so echoing it in the request proves
/// nothing. Issue one 1-byte range request and require a real `206`.
///
/// 只看 `Accept-Ranges` 会放走一类真实存在的坏服务器：它挂着这个头却无视 Range，
/// 每次都回 200 整份文件。被判「可分段」之后，每个 from>0 的段都会撞上 `fetch_and_write`
/// 的错位保护，归零重下三次仍拿到 200，最终升级成 "server ignored Range request on
/// every attempt" —— 用户端表现就是一个干脆的下载失败，而这本可以单线程正常下完。
/// 所以这里只认真正的 206；判 false 退回单线程是安全的（首段 from==0，200 可接受）。
async fn check_ranges(client: &reqwest::Client, url: &str) -> bool {
    match send_headers(client.get(url).header("Range", "bytes=0-0"), HEADERS_TIMEOUT).await {
        Ok(resp) => {
            let st = resp.status().as_u16();
            drop(resp);
            st == 206
        }
        Err(_) => false,
    }
}

/// 从响应头里问出总长度：优先 `Content-Range: bytes a-b/<total>` 的总长，退回
/// `Content-Length`。缺头、非数字、或算出来是 0 都返回 `None` = **长度未知**
/// （0 不能当已知长度用：拿它去分段会得到 `[0, u64::MAX]` 这种荒谬区间）。
/// 纯函数，便于单元测试。
fn total_from_headers(content_range: Option<&str>, content_length: Option<&str>) -> Option<u64> {
    content_range
        .and_then(|s| s.rsplit_once('/'))
        .and_then(|(_, t)| t.trim().parse::<u64>().ok())
        .or_else(|| content_length.and_then(|s| s.trim().parse::<u64>().ok()))
        .filter(|&t| t > 0)
}

/// `Accept-Ranges: bytes` 只说明「这台服务器*可能*答得出区间」。探测阶段用它做的
/// 判断仅限于「要不要再发一次带 Range 的 GET 去问长度」；真正能不能分段仍然只认
/// `check_ranges` 拿到的 206（坑 2）。
fn accepts_ranges_header(v: Option<&HeaderValue>) -> bool {
    v.and_then(|s| s.to_str().ok())
        .map(|s| s.to_ascii_lowercase().contains("bytes"))
        .unwrap_or(false)
}

/// Total size via HEAD, falling back to a ranged GET when HEAD is unusable.
/// Both legs share ONE `PROBE_TIMEOUT` budget: the fallback gets whatever the first
/// leg left, so the total can't stack past the deadline. The fallback is skipped
/// entirely when HEAD just timed out — a host that never answers HEAD won't answer
/// GET either, so the second leg would only burn the remaining budget for nothing.
///
/// 返回 `Ok(None)` 表示「连上了、也正常应答了，但就是问不出长度」（chunked 流式接口）。
/// 这和 `Err`（连不上/超时/服务端拒绝）必须严格区分：前者要退化成单流顺序下载，
/// 后者才是真的失败。`Ok(None)` 的判定路径**不会**发出任何 `Range` 请求：
/// HEAD 说得出话却没给长度时，只有它自己声称 `Accept-Ranges: bytes` 才值得再补一次
/// 带区间的 GET（206 的 `Content-Range` 能报总长）；否则发 Range 只会白白拉回一整份
/// 正文再丢掉——未知长度下载从探测阶段起就不该请求区间。
async fn probe_total(client: &reqwest::Client, url: &str) -> Result<Option<u64>, String> {
    fn total_from(resp: &reqwest::Response) -> Option<u64> {
        total_from_headers(
            resp.headers().get("Content-Range").and_then(|v| v.to_str().ok()).as_deref(),
            resp.headers().get("Content-Length").and_then(|v| v.to_str().ok()).as_deref(),
        )
    }

    let started = Instant::now();
    match send_headers(client.head(url), PROBE_TIMEOUT).await {
        // HEAD answered successfully: use it directly.
        Ok(r) if r.status().is_success() => match total_from(&r) {
            Some(t) => return Ok(Some(t)),
            // 不支持区间的服务器不值得再发一次 Range 请求，直接判「长度未知」。
            None if !accepts_ranges_header(r.headers().get("Accept-Ranges")) => return Ok(None),
            None => {}
        },
        // HEAD timed out: the host isn't going to answer a ranged GET either.
        Err(FetchErr { fatal: false, .. }) => return Err("server did not reply".to_string()),
        // HEAD 被拒（403/405）或发送失败：给带区间的 GET 剩下的预算。
        _ => {}
    }
    let remaining = PROBE_TIMEOUT.saturating_sub(started.elapsed());
    if remaining.is_zero() {
        return Err(format!("server did not reply within {}s", PROBE_TIMEOUT.as_secs()));
    }
    match send_headers(client.get(url).header("Range", "bytes=0-0"), remaining).await {
        // 兜底这一次也问不出长度 → 同样是「未知长度」，不是失败。
        Ok(r) => Ok(total_from(&r)),
        Err(e) => Err(e.msg),
    }
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

/// 解析 `Content-Range: bytes {first}-{last}/{total}` 头，返回 (first, last, total)。
/// 无法解析（缺 total、单位不是 bytes、区间反了、或 `*` 通配）返回 None。
/// 注意旧实现用 `split('=')` 找值，但这个头里根本没有 `=`，所以那条路永远走不通。
fn parse_content_range(v: &str) -> Option<(u64, u64, u64)> {
    let v = v.trim();
    let (unit, rest) = v.split_once(char::is_whitespace)?;
    if !unit.eq_ignore_ascii_case("bytes") {
        return None;
    }
    let (range, total) = rest.trim().split_once('/')?;
    let total = total.trim();
    let total: u64 = if total == "*" { u64::MAX } else { total.parse().ok()? };
    let (fs, ls) = range.split_once('-')?;
    let first: u64 = fs.trim().parse().ok()?;
    let last: u64 = ls.trim().parse().ok()?;
    if last < first {
        return None;
    }
    Some((first, last, total))
}

/// 本次响应「应当写入的字节数」。优先用 `Content-Range` 的区间长度（`last-first+1`），
/// 并校验区间起点等于我们请求的 `from`——服务器返回别的区间意味着它没照我们的 Range 发，
/// 写下去必坏，故用 Err(()) 让调用方判失败。`Content-Range` 缺失或解析不了才退回
/// `Content-Length`（200 整份文件响应就走这条）。两者都没有时返回 Ok(None)。
/// 纯函数，便于单元测试。
fn expected_len(
    content_range: Option<&str>,
    content_length: Option<u64>,
    from: u64,
) -> Result<Option<u64>, ()> {
    if let Some(cr) = content_range {
        if let Some((first, last, _total)) = parse_content_range(cr) {
            if first != from {
                return Err(());
            }
            return Ok(Some(last - first + 1));
        }
    }
    Ok(content_length)
}

async fn fetch_and_write(
    client: &reqwest::Client,
    url: &str,
    from: u64,
    end: u64,
    size: u64,
    file: &mut tokio::fs::File,
    on_progress: OnProgress,
    rate: &Arc<Mutex<Bucket>>,
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
            restart_from_zero: false,
        });
    }
    // 我们请求了 Range，服务器却没回 206 而是 200 —— 它无视了 Range，正文是整份文件。
    // 真正危险的判据不是 ranges_ok，而是本次请求的起始偏移 from 是否为 0：
    //   - from == 0：正文头一段恰好就是本段内容（写盘受 remaining 封顶），可安全接受；
    //   - from  > 0：把「从 0 开始」的正文写到 from 偏移会整体错位 → 数据损坏。
    // 后者必须失败，并让 worker 把该段 done 归零从段首重下（自愈），而不是原地空转。
    if st != 206 && from != 0 {
        return Err(FetchErr {
            msg: "server ignored Range request".into(),
            fatal: false,
            restart_from_zero: true,
        });
    }
    // 期望长度：优先 Content-Range（并校验区间起点），退回 Content-Length，再退回 size。
    let cr = resp.headers().get("Content-Range").and_then(|v| v.to_str().ok());
    let expect = match expected_len(cr, resp.content_length(), from) {
        Ok(Some(n)) => n.min(end - from + 1),
        Ok(None) => size,
        Err(()) => {
            return Err(FetchErr {
                msg: format!("server returned a range not starting at {from}"),
                fatal: true,
                restart_from_zero: false,
            });
        }
    };
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
                    let want = ((pos + CHUNK as usize).min(bytes.len()) - pos).min(room);
                    // 令牌桶在这里放行：桶空了就把写盘 await 住（本任务所有分段共用同一个
                    // 桶，所以是总速度受限，不是每段各限一份）。只写真正拿到配额的那几个
                    // 字节，剩下的下一轮再来。
                    let chunk = throttle(rate, want as u64).await.min(want as u64) as usize;
                    file.write_all(&bytes[pos..pos + chunk]).await
                        .map_err(|e| FetchErr { msg: e.to_string(), fatal: true, restart_from_zero: false })?;
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
                        restart_from_zero: false,
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
                        restart_from_zero: false,
                    });
                }
                return Err(FetchErr { msg: req_err(&e), fatal: false, restart_from_zero: false });
            }
            Err(_) => {
                return Err(FetchErr { msg: "read timeout".into(), fatal: false, restart_from_zero: false });
            }
        }
    }
    Ok(written)
}

/// 长度未知时的单流下载：**不发 `Range`**，一直读到流自然结束。
///
/// 和 `fetch_and_write` 的关键区别：
///  - 没有区间可对账，所以「读完」的唯一信号是 stream 给出 `None`（EOF）。中途报错
///    或空闲超时一律算失败，由调用方从 0 重下（不允许请求区间，就没法要求服务端从
///    偏移 X 续传）。
///  - 收到 200 是完全正常的（我们根本没请求区间）；反过来，万一服务器对无 Range 的
///    请求回了 206，说明正文只是文件的一段，拼起来必然缺字节 → 判失败。
/// 返回值为实际写入的字节数，调用方据此回填 `total`。
async fn fetch_unbounded(
    client: &reqwest::Client,
    url: &str,
    file: &mut tokio::fs::File,
    on_progress: OnProgress,
    rate: &Arc<Mutex<Bucket>>,
) -> Result<u64, FetchErr> {
    let resp = send_headers(client.get(url), HEADERS_TIMEOUT).await?;
    let st = resp.status().as_u16();
    if !resp.status().is_success() {
        return Err(FetchErr {
            msg: format!("http {st}"),
            fatal: is_fatal_status(st),
            restart_from_zero: false,
        });
    }
    if st == 206 {
        return Err(FetchErr {
            msg: "server answered 206 to a request without Range".into(),
            fatal: true,
            restart_from_zero: false,
        });
    }
    let mut stream = resp.bytes_stream();
    let mut written = 0u64;
    loop {
        match tokio::time::timeout(CHUNK_IDLE, stream.try_next()).await {
            Ok(Ok(Some(bytes))) => {
                let mut pos = 0usize;
                while pos < bytes.len() {
                    let want = (bytes.len() - pos).min(CHUNK as usize);
                    let chunk = throttle(rate, want as u64).await.min(want as u64) as usize;
                    file.write_all(&bytes[pos..pos + chunk]).await
                        .map_err(|e| FetchErr { msg: e.to_string(), fatal: true, restart_from_zero: false })?;
                    written += chunk as u64;
                    pos += chunk;
                    if let Some((p, base)) = &on_progress {
                        p.store(base + written, Ordering::Relaxed);
                    }
                }
            }
            Ok(Ok(None)) => break, // EOF：长度未知的响应里，这就是「发完了」的唯一凭据。
            Ok(Err(e)) => {
                // 这里分不清「服务端提前断链」和「本来就只剩这点内容」，
                // 只能按失败重下——重下的代价远比交付一个残缺文件小。
                return Err(FetchErr { msg: req_err(&e), fatal: false, restart_from_zero: false });
            }
            Err(_) => {
                return Err(FetchErr { msg: "read timeout".into(), fatal: false, restart_from_zero: false });
            }
        }
    }
    Ok(written)
}

/// Drive one segment to completion. Only the worker holding `gen` writes it.
async fn worker(task: Arc<Mutex<Task>>, index: usize, gen: usize) {
    let (client, url, part, paused, cancelled, rate) = {
        let g = task.lock().await;
        (
            g.client.clone(),
            g.url.clone(),
            g.tmp_path(),
            g.paused.clone(),
            g.cancelled.clone(),
            g.rate.clone(),
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
    // 连续「服务器无视 Range、要求从段首重下」的次数。对首段（start==0）重下即成功，
    // 计数不会累积；但若某段起点非 0 且服务器每次都无视 Range，重下也无法自愈，
    // 累计到阈值就升级成 fatal，避免无限空转的死循环。
    let mut zrestart_streak: u32 = 0;
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
            &client, &url, from, end, size, &mut file, progress_cb, &rate,
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
                zrestart_streak = 0;
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
                // 服务器无视了 Range（本次 from>0）：把该段进度归零，下一轮重新 seek 到
                // 段首、从段首再请求。对单段任务（start==0）这一试就成功，能自愈。
                if e.restart_from_zero {
                    done = 0;
                    {
                        let mut g = task.lock().await;
                        if g.gen == gen {
                            if let Some(s) = g.segments.get_mut(index) {
                                s.downloaded = 0;
                            }
                        }
                    }
                    zrestart_streak += 1;
                    // 连续多次仍拿到 200：说明该段起点非 0 且服务器每次都无视 Range，
                    // 从段首重下也救不回来，升级成 fatal，不再空转。
                    const MAX_ZRESTART: u32 = 3;
                    if zrestart_streak >= MAX_ZRESTART {
                        let mut g = task.lock().await;
                        if g.gen == gen {
                            if let Some(s) = g.segments.get_mut(index) {
                                s.status = "error".into();
                            }
                            g.error = "server ignored Range request on every attempt".into();
                        }
                        return;
                    }
                } else {
                    zrestart_streak = 0;
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
                tokio::time::sleep(retry_backoff(attempt, index)).await;
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

/// 重试退避：指数封顶 30s。抖动故意只往下走（80%..100%）而不是上下抖——
/// 抖动超过封顶就失去意义了。多个 worker 若同时重试会一起把服务器压死，
/// 所以按 attempt×7 + index×13 做确定性伪随机，避免引 rand。
fn retry_backoff(attempt: usize, index: usize) -> Duration {
    let base = (1u64 << attempt.min(5)).min(RETRY_BACKOFF_CAP);
    let phase = ((attempt * 7 + index * 13) % 5) as u64;
    let jitter = 80 + phase * 5; // 80%..100%
    Duration::from_secs((base * jitter / 100).max(1))
}

/// 长度未知（探测不出 `Content-Length`、也没有真正的 206）时的驱动：一条流顺序读到 EOF。
///
/// 与 `worker` 必须分开写的原因：
///  - 段没有确定边界，所以「完成」由读到 EOF 判定（置 `stream_done`），不能靠
///    `done >= size`——占位段的 size 是 1，写进一个字节就会被当成整段完成、
///    把半截 `.part` rename 成成品；
///  - **不发 Range**，所以中途断线只能从 0 重下（没法要求服务端从偏移 X 继续）；
///  - **不支持断点续传**：长度未知，`.part` 里已有的前缀无法证明属于同一份内容
///    （上一轮只写了半截、或服务器把文件换掉了都看不出来），所以每次 run 都从 0
///    覆盖重写，`ensure_part` 也绝不 `set_len`；
///  - EOF 后把 `total` 回填成实际写入字节数，界面与落盘的任务记录才有正确大小。
async fn worker_stream(task: Arc<Mutex<Task>>, gen: usize) {
    // 未知长度只有一个段，索引恒 0。
    const IDX: usize = 0;
    let (client, url, part, paused, cancelled, rate) = {
        let g = task.lock().await;
        (
            g.client.clone(),
            g.url.clone(),
            g.tmp_path(),
            g.paused.clone(),
            g.cancelled.clone(),
            g.rate.clone(),
        )
    };

    let mark_error = |task: &Arc<Mutex<Task>>, gen: usize, msg: String| {
        let t = task.clone();
        async move {
            let mut g = t.lock().await;
            if g.gen == gen {
                if let Some(s) = g.segments.get_mut(IDX) {
                    s.status = "error".into();
                }
                g.error = msg;
            }
        }
    };

    let mut file = match tokio::fs::OpenOptions::new().read(true).write(true).open(&part).await {
        Ok(f) => f,
        Err(e) => {
            mark_error(&task, gen, format!("open part: {e}")).await;
            return;
        }
    };

    let counter = Arc::new(AtomicU64::new(0));
    let mut written = 0u64;
    let mut attempt = 0usize;
    let mut interval_start = Instant::now();
    let mut interval_bytes = 0u64;

    let total_bytes: u64 = loop {
        if cancelled.load(Ordering::Relaxed) {
            return;
        }
        {
            let g = task.lock().await;
            if g.gen != gen {
                return;
            }
        }
        if paused.load(Ordering::Relaxed) {
            tokio::time::sleep(Duration::from_millis(50)).await;
            continue;
        }

        // 每次尝试都从文件头覆盖重写：不给区间就没法要求服务端接着上次发。
        counter.store(0, Ordering::Relaxed);
        if file.seek(SeekFrom::Start(0)).await.is_err() {
            mark_error(&task, gen, "seek failed".into()).await;
            return;
        }
        let outcome = {
            let fut = fetch_unbounded(&client, &url, &mut file, Some((counter.clone(), 0)), &rate);
            tokio::pin!(fut);
            let mut progress = tokio::time::interval(PROGRESS_INTERVAL);
            loop {
                tokio::select! {
                    r = &mut fut => break r,
                    _ = progress.tick() => {
                        if cancelled.load(Ordering::Relaxed) {
                            return;
                        }
                        let live = counter.load(Ordering::Relaxed);
                        if live > written {
                            interval_bytes += live - written;
                            written = live;
                        }
                        let mut g = task.lock().await;
                        if g.gen != gen {
                            return;
                        }
                        if let Some(s) = g.segments.get_mut(IDX) {
                            // `total` 还是 0，所以 progress 恒 0，但已下字节数要看得见。
                            s.downloaded = written;
                            if interval_bytes > 0 {
                                let el = interval_start.elapsed().as_secs_f64().max(0.001);
                                s.speed = interval_bytes as f64 / el;
                                interval_start = Instant::now();
                                interval_bytes = 0;
                            }
                        }
                    }
                }
            }
        };
        match outcome {
            Ok(n) => {
                let live = counter.load(Ordering::Relaxed);
                if live > n {
                    // fetch 的计数器和返回值理应一致；以写得更多的为准也不影响正确性
                    // （同一个文件的同一前缀），但别把字节数算少了。
                    written = live;
                }
                break n.max(written);
            }
            Err(e) => {
                // 下一次尝试从 0 重写，进度计数器与折算量都要归零。
                written = 0;
                interval_bytes = 0;
                if e.fatal {
                    mark_error(&task, gen, e.msg).await;
                    return;
                }
                {
                    let mut g = task.lock().await;
                    if g.gen != gen {
                        return;
                    }
                    g.error = e.msg.clone();
                    if let Some(s) = g.segments.get_mut(IDX) {
                        s.downloaded = 0;
                        s.speed = 0.0;
                    }
                }
                attempt += 1;
                tokio::time::sleep(retry_backoff(attempt, IDX)).await;
            }
        }
    };

    // 收尾：上一轮重试可能比这一轮写得多，用真实长度把尾巴截掉。注意这跟
    // `ensure_part` 里禁止的 `set_len` 不是一回事——这里 `total_bytes` 是已经确定的
    // 真实长度，截掉的都是重复/残留字节。
    let _ = file.flush().await;
    if file.set_len(total_bytes).await.is_err() {
        drop(file);
        mark_error(&task, gen, "truncate failed".into()).await;
        return;
    }
    drop(file);

    // 定稿前再看一眼代际：新 run 可能已经接管这个 `.part`，别把它的状态盖掉。
    let mut g = task.lock().await;
    if g.gen != gen {
        return;
    }
    g.total = total_bytes;
    g.stream_done = true;
    g.error = String::new();
    if let Some(s) = g.segments.get_mut(IDX) {
        s.start = 0;
        s.end = total_bytes.saturating_sub(1);
        s.downloaded = total_bytes;
        s.speed = 0.0;
        s.status = "done".into();
    }
    // 不在这里发 done / 不改 state：终态快照与 `done` 事件的先后顺序由主循环的 tick
    // 统一保证（先发带终态的 progress，再发 done/error）。
}

/// 删除 `.part` 与 sidecar 并把偏移归零。stop 的语义是放弃下载。
async fn discard_progress(g: &mut Task) {
    let _ = tokio::fs::remove_file(&g.tmp_path()).await;
    let _ = tokio::fs::remove_file(&g.sidecar_path()).await;
    g.stream_done = false;
    for s in &mut g.segments {
        s.downloaded = 0;
        s.speed = 0.0;
        s.status = "waiting".into();
    }
}

async fn spawn_workers(task: Arc<Mutex<Task>>, gen: usize) {
    if task.lock().await.unknown_len {
        // 长度未知：段布局是占位的，走单流驱动，绝不发 Range。
        {
            let mut g = task.lock().await;
            if let Some(s) = g.segments.get_mut(0) {
                s.status = "running".into();
            }
        }
        tokio::spawn(worker_stream(task, gen));
        return;
    }
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
            // 第一条应答的形状不能改：主进程靠 `state=="preparing"` 区分「还在探测」，
            // 且这条里的 total 是上一轮继承的旧值——任何依赖 total 的放行
            // 只能落在下面那条 `state == "idle"` 的完整快照上。
            let _ = emit_line(out, json!({"event":"progress","data":{"state":"preparing"}})).await;
            // 校验和参数先解析：格式不对/算法不支持就当场报错，
            // 别等几十 GB 下完才说校不了。
            let checksum = match parse_checksum(&cmd.checksum) {
                Ok(c) => c,
                Err(e) => {
                    let _ = emit_line(out, json!({"event":"error","error":e})).await;
                    return;
                }
            };
            let client = match make_client(&cmd.proxy, &cmd.user_agent) {
                Ok(c) => c,
                Err(e) => {
                    let _ = emit_line(out, json!({"event":"error","error":e})).await;
                    return;
                }
            };
            let probed = match probe_total(&client, &cmd.url).await {
                Ok(t) => t,
                Err(e) => {
                    let _ = emit_line(out, json!({"event":"error","error":e})).await;
                    return;
                }
            };
            // `None` = 服务器正常应答但问不出长度 → 退化成单流顺序下载。
            // 从这一刻起本工程再不发任何 `Range` 请求头（连 check_ranges 也不跑），
            // 因为「请求了区间却收到 200」在这条路径上根本无法判别，只能整份顺序读。
            let (total, ranges_ok) = match probed {
                Some(t) => (t, check_ranges(&client, &cmd.url).await),
                None => (0u64, false),
            };
            let threads = if ranges_ok {
                cmd.threads.max(1).min((total / MIN_SEGMENT).max(1) as usize)
            } else {
                1
            };
            let rate_kbps = cmd.rate_limit_kbps.unwrap_or(0);
            let mut t = Task {
                url: cmd.url.clone(),
                dest: cmd.dest.clone(),
                threads,
                total,
                ranges_ok,
                unknown_len: probed.is_none(),
                stream_done: false,
                checksum,
                verifying: false,
                rate_kbps,
                rate: Arc::new(Mutex::new(Bucket::new(rate_kbps))),
                id: NEXT_TASK_ID.fetch_add(1, Ordering::Relaxed),
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
                // run/resume 也接受限速与校验参数，但只在字段真的给了的情况下才改：
                // 一条裸 `{"cmd":"run"}` 不该把 probe 设好的限速抹成不限速。
                if let Some(kbps) = cmd.rate_limit_kbps {
                    t.lock().await.set_rate(kbps).await;
                }
                if !cmd.checksum.is_empty() {
                    match parse_checksum(&cmd.checksum) {
                        Ok(cs) => t.lock().await.checksum = cs,
                        Err(e) => {
                            let _ = emit_line(out, json!({"event":"error","error":e})).await;
                            return;
                        }
                    }
                }
                let gen;
                {
                    let mut g = t.lock().await;
                    // 重新开跑就把「校验中」清掉：上一轮后台校验的结果已经作废
                    // （主循环那边也会丢掉通道），留着会把新一次下载的收尾卡死。
                    g.verifying = false;
                    // 已完成后再收到 run/resume：绝不能重建全零 .part 再 rename 覆盖成品。
                    // 先看成品在不在、大小对不对：在就把状态置回 done 并发一条 done（幂等），
                    // 不在（成品被删/损坏）才把偏移清零、老老实实从头下。
                    if g.all_done() {
                        let dest_ok = tokio::fs::metadata(&g.dest)
                            .await
                            .map(|m| m.len() == g.total)
                            .unwrap_or(false);
                        if dest_ok {
                            g.state = "done".into();
                            g.error = String::new();
                            let _ = emit_line(out, json!({"event":"done","total":g.total})).await;
                            return;
                        }
                        for s in &mut g.segments {
                            s.downloaded = 0;
                            s.speed = 0.0;
                            s.status = "waiting".into();
                        }
                        g.stream_done = false;
                        g.save_sidecar();
                    }
                    // ensure_part 会校验 .part 的真实状态，必要时（文件没了/长度不对）
                    // 自己把偏移清零，所以这里不必再担心边车与文件不一致。
                    // 长度未知的任务里它只负责建文件，且绝不 set_len。
                    if let Err(e) = g.ensure_part().await {
                        let _ = emit_line(out, json!({"event":"error","error":e})).await;
                        return;
                    }
                    // 必须先换代、再清 pause：反过来的话，还在 park 的旧 worker
                    // 会把 pause 清掉当成自己该继续跑，和新 worker 一起写同一段。
                    g.gen += 1;
                    g.cancelled.store(false, Ordering::Relaxed);
                    g.paused.store(false, Ordering::Relaxed);
                    g.state = "downloading".into();
                    g.error = String::new();
                    gen = g.gen;
                }
                let snap = t.lock().await.snapshot();
                let _ = emit_line(out, json!({"event":"progress","data":snap})).await;
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
                if g.total > 0 && g.ranges_ok && !g.unknown_len && g.state != "downloading" {
                    let new_n = cmd.n.max(1).min((g.total / MIN_SEGMENT).max(1) as usize);
                    if new_n != g.threads {
                        // 先记下老布局，重切之后按「老段真正下载的字节区间」和新段求交集
                        // 重新摊回进度，否则换线程数会把已下载的量算错（虚高或清零）。
                        let old_segs: Vec<(u64, u64, u64)> = g.segments
                            .iter().map(|x| (x.start, x.end, x.downloaded)).collect();
                        g.threads = new_n;
                        g.build_segments();
                        if !old_segs.is_empty() {
                            for seg in &mut g.segments {
                                let got = recompute_segment(seg.start, seg.end, &old_segs);
                                seg.downloaded = got;
                                seg.status = if seg.done() { "done" } else { "waiting" }.into();
                            }
                        }
                        g.save_sidecar();
                    }
                }
                let _ = emit_line(out, json!({"event":"progress","data":g.snapshot()})).await;
            }
        }
        "set_rate" => {
            // 运行中随时改限速（含调回 0 取消）。桶是每任务一份、所有分段共享的，
            // 所以改一次全部 worker 立刻跟着变。和 set_threads 一样回一条 progress 快照。
            if let Some(t) = task.clone() {
                // `n` 是 `set_threads` 用的字段，这里当作便捷别名兜一下：
                // 只有 `rate_limit_kbps` 缺省时才退回去看它，`0` 不接管（无法和「没给」区分）。
                let kbps = cmd.rate_limit_kbps.or(if cmd.n > 0 { Some(cmd.n as u64) } else { None });
                if let Some(kbps) = kbps {
                    t.lock().await.set_rate(kbps).await;
                }
                let _ = emit_line(out, json!({"event":"progress","data":t.lock().await.snapshot()})).await;
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

/// 每个 `PROGRESS_INTERVAL` 走一次：折算速度、判定终态、推快照 + 终态事件。
///
/// 拆出函数是因为校验和让「收尾」有了三条路（无校验和直接完成 / 起校验 / 校验回来定终态），
/// 全塞进 `select!` 的 arm 里锁的边界会看不清。三条路都遵守同一条顺序：
/// **先发带终态的 progress 快照，再发 done/error**，这样主进程即使此刻被杀掉，
/// 落盘的任务记录里也已经是终态。
async fn on_tick(
    t: &Arc<Mutex<Task>>,
    out: &mut tokio::io::BufWriter<Stdout>,
    verify_rx: &mut Option<mpsc::UnboundedReceiver<VerifyResult>>,
    last_downloaded: &mut u64,
    last_speed_at: &mut Instant,
) {
    // ---- 1) 后台校验回来了吗 ----
    // 轮询而不是加一条 select 分支：校验是纯粹的一次顺序读，100ms 的粒度足够，
    // 少一个分支就少一处「stdin 和校验结果抢同一个锁」的坑。
    let vr = {
        if t.lock().await.verifying {
            verify_rx.as_mut().and_then(|rx| rx.try_recv().ok())
        } else {
            None
        }
    };
    if let Some(vr) = vr {
        *verify_rx = None;
        let mut g = t.lock().await;
        // 只接受「本任务、本代」的结果：期间可能已经 probe 换了任务或 run/stop 换了代，
        // 陈旧结果必须丢掉，否则会把别的任务的终态盖上来。
        if g.verifying && vr.task_id == g.id && vr.gen == g.gen {
            g.verifying = false;
            let msg = match vr.error {
                None => {
                    g.state = "done".into();
                    g.error = String::new();
                    finalize(&g).await
                }
                // 校验不过：**保留文件不删**（不 rename、也不清 .part），让用户自己决定
                // 是重试还是删掉——直接删等于把几十 GB 的流量白烧了。
                Some(e) => {
                    g.state = "error".into();
                    g.error = e.clone();
                    Some(json!({"event":"error","error":e}))
                }
            };
            let snap = g.snapshot();
            drop(g);
            *last_speed_at = Instant::now();
            emit_line(out, json!({"event":"progress","data":snap})).await;
            if let Some(m) = msg {
                emit_line(out, m).await;
            }
        }
        return;
    }

    // ---- 2) 常规推进 ----
    let st = {
        let g = t.lock().await;
        (g.state.clone(), g.downloaded())
    };
    if st.0 != "downloading" {
        return;
    }
    // EMA of overall speed across the tick interval.
    let el = last_speed_at.elapsed().as_secs_f64().max(0.001);
    // saturating：断线重下、以及未知长度从 0 重来都会让 `downloaded()` 往回跳，
    // 直接相减会在 debug 构建里 panic、release 里绕成一个巨大的速度。
    let inst = st.1.saturating_sub(*last_downloaded) as f64 / el;
    let mut g = t.lock().await;
    g.speed = if g.speed <= 0.0 { inst } else { g.speed * 0.7 + inst * 0.3 };
    let mut finish_msg = None;
    if g.any_error() {
        g.state = "error".into();
        finish_msg = Some(json!({"event":"error","error":g.error.clone()}));
    } else if g.all_done() {
        if g.verifying {
            // 校验还在后台跑：state 保持 downloading，快照里 verifying=true，
            // 主进程据此显示「校验中」。这里不做任何收尾。
        } else if let Some(cs) = g.checksum.clone() {
            // 所有分段完成、rename 之前：起一次流式哈希。
            // 边下边算是错的——多分段乱序写入 + 断点续传（同一区间可能被重写多次）
            // 会让前缀哈希不可复现，只有落盘后按文件顺序单遍读才拿得到确定结果。
            g.verifying = true;
            let (tx, rx) = mpsc::unbounded_channel();
            tokio::spawn(run_verify(cs, g.tmp_path(), g.id, g.gen, tx));
            *verify_rx = Some(rx);
            g.save_sidecar();
        } else {
            g.state = "done".into();
            finish_msg = finalize(&g).await;
        }
    } else {
        g.save_sidecar();
    }
    *last_downloaded = st.1;
    *last_speed_at = Instant::now();
    let snap = g.snapshot();
    drop(g);
    emit_line(out, json!({"event":"progress","data":snap})).await;
    if let Some(m) = finish_msg {
        emit_line(out, m).await;
    }
}

/// Read one line from stdin into `buf`.
///
/// 用 `read_until(b'\n')` 拿到原始字节再 `from_utf8_lossy`，而不是 `read_line`——后者遇到
/// 非 UTF-8 字节会返回 Err，旧代码把 Err 当成 EOF 处理（`Ok(_) => None`），于是 Electron 只要
/// 塞进一行坏字节，`main` 的 loop 就 `break`、进程安静 exit 0，协议里连一条 error 事件都没有。
/// 现在非法字节被替换成 U+FFFD，交给 `serde_json` 报 bad json，进程照常存活。
/// 返回：`Ok(Some(line))` 有内容 / `Ok(None)` 干净 EOF / `Err` 真的 IO 读取出错。
async fn read_stdin_line(
    reader: &mut BufReader<tokio::io::Stdin>,
    buf: &mut Vec<u8>,
) -> Result<Option<String>, std::io::Error> {
    buf.clear();
    let n = reader.read_until(b'\n', buf).await?;
    if n == 0 {
        return Ok(None);
    }
    let s = String::from_utf8_lossy(buf);
    Ok(Some(s.trim().to_string()))
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let mut task: Option<Arc<Mutex<Task>>> = None;
    let mut last_downloaded: u64 = 0;
    let mut last_speed_at = Instant::now();
    // 后台校验结果的通道。None = 没有正在等的校验。
    let mut verify_rx: Option<mpsc::UnboundedReceiver<VerifyResult>> = None;

    let mut reader = BufReader::new(stdin());
    let mut line_buf: Vec<u8> = Vec::new();
    let mut out = tokio::io::BufWriter::new(stdout());
    let mut tick = tokio::time::interval(PROGRESS_INTERVAL);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            line = read_stdin_line(&mut reader, &mut line_buf) => {
                let line = match line {
                    Ok(Some(t)) => t,
                    // 干净 EOF：Electron 关掉了 stdin，正常退出。
                    Ok(None) => break,
                    // 真的读不出来（IO Err）：退出前先吐一条 error 事件，别静默消失。
                    Err(e) => {
                        let msg = json!({"event":"error","error":format!("stdin read error: {e}")});
                        let _ = out.write_all((msg.to_string() + "\n").as_bytes()).await;
                        let _ = out.flush().await;
                        break;
                    }
                };
                if line.is_empty() {
                    continue;
                }
                let cmd = match serde_json::from_str::<Cmd>(&line) {
                    Ok(c) => c,
                    Err(e) => {
                        let msg = json!({"event":"error","error":format!("bad json: {e}")});
                        let _ = out.write_all((msg.to_string() + "\n").as_bytes()).await;
                        let _ = out.flush().await;
                        continue;
                    }
                };
                // 换任务 / 放弃任务时正在跑的校验结果就地作废（通道一丢，Sender 那边
                // 发送失败自动结束）。任务代号的对齐检查是第二道保险。
                if matches!(cmd.cmd.as_str(), "probe" | "stop") {
                    verify_rx = None;
                }
                handle(cmd, &mut task, &mut out).await;
            }
            _ = tick.tick() => {
                if let Some(t) = &task {
                    on_tick(t, &mut out, &mut verify_rx, &mut last_downloaded, &mut last_speed_at).await;
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        accepts_ranges_header, bucket_capacity, expected_len, hash_file, parse_checksum,
        parse_content_range, recompute_segment, refill_tokens, run_verify, throttle,
        total_from_headers, Alg, Bucket, Checksum, CHUNK, HASH_BUF,
    };
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    use tokio::sync::{mpsc, Mutex};
    use sha2::Digest;

    // ---- Content-Range 解析（对应缺陷 2：旧 split('=') 死代码）----
    #[test]
    fn parse_content_range_real_format() {
        // 真实格式没有 '='，旧实现因此永远解析不到。
        assert_eq!(parse_content_range("bytes 100-1099/2000"), Some((100, 1099, 2000)));
        assert_eq!(parse_content_range("bytes 0-0/10"), Some((0, 0, 10)));
        assert_eq!(parse_content_range("bytes 0-11759999/11760000"), Some((0, 11759999, 11760000)));
    }

    #[test]
    fn parse_content_range_rejects_unusable() {
        assert_eq!(parse_content_range("bytes */2000"), None); // 无区间
        assert_eq!(parse_content_range("items 0-9/10"), None); // 单位不是 bytes
        assert_eq!(parse_content_range("bytes 200-100/300"), None); // 区间反了
        assert_eq!(parse_content_range("nonsense"), None);
    }

    #[test]
    fn expected_len_prefers_content_range_and_checks_from() {
        // Content-Range 命中：期望长度 = last-first+1，而不是 Content-Length。
        // bytes 100-1099 → 1099-100+1 = 1000 字节（旧实现因 split('=') 死代码只能退回
        // Content-Length，而 206 的 Content-Length 恰好也等于该发的字节数，截断检不出来）。
        assert_eq!(expected_len(Some("bytes 100-1099/2000"), Some(1000), 100), Ok(Some(1000)));
        // 服务器声明 Content-Length 900，却只返回从 100 起 500 字节的区间 → 期望 500（更小、更权威）。
        assert_eq!(expected_len(Some("bytes 100-599/2000"), Some(900), 100), Ok(Some(500)));
        // 区间起点与请求的 from 不符 → 必须判失败。
        assert_eq!(expected_len(Some("bytes 200-299/2000"), Some(100), 100), Err(()));
        // 没有 Content-Range（如 200 整份文件）→ 退回 Content-Length。
        assert_eq!(expected_len(None, Some(1234), 0), Ok(Some(1234)));
        // 两者都没有 → Ok(None)，由调用方兜底。
        assert_eq!(expected_len(None, None, 0), Ok(None));
    }

    // ---- 长度解析：未知长度必须是「None」而不是 0 或错误 ----
    #[test]
    fn total_from_headers_known_and_unknown() {
        // 206：以 Content-Range 的总长为准，而不是本次只发的那些字节。
        assert_eq!(total_from_headers(Some("bytes 0-99/1000"), Some("100")), Some(1000));
        // 200 整份：只有 Content-Length。
        assert_eq!(total_from_headers(None, Some("12345")), Some(12345));
        assert_eq!(total_from_headers(Some("garbage"), Some("777")), Some(777));
        // chunked / 未知长度：两个头都没有 → None（走单流顺序下载）。
        assert_eq!(total_from_headers(None, None), None);
        // Content-Range 的总长是 `*` 且没有 Content-Length → 未知。
        assert_eq!(total_from_headers(Some("bytes 0-9/*"), None), None);
        // 0 不能当已知长度：拿它去分段会得到 `[0, u64::MAX]` 这种荒谬区间。
        assert_eq!(total_from_headers(None, Some("0")), None);
        assert_eq!(total_from_headers(Some("bytes */0"), None), None);
        // 非数字、空白容忍。
        assert_eq!(total_from_headers(Some("bytes 0-9/ unknown "), None), None);
        assert_eq!(total_from_headers(None, Some(" 42 ")), Some(42));
    }

    #[test]
    fn accept_ranges_header_only_decides_whether_to_ask_again() {
        use reqwest::header::HeaderValue;
        assert!(accepts_ranges_header(Some(&HeaderValue::from_static("bytes"))));
        assert!(accepts_ranges_header(Some(&HeaderValue::from_static("Bytes"))));
        // 挂着 `none` 的服务器不该被再发一次 Range 请求（坑 2：能不能分段只认 206）。
        assert!(!accepts_ranges_header(Some(&HeaderValue::from_static("none"))));
        assert!(!accepts_ranges_header(None));
    }

    // ---- 令牌桶（限速）----
    #[test]
    fn refill_tokens_is_linear_in_time_and_rate() {
        // 64 KiB/s 跑满 1s = 65536 字节。
        assert_eq!(refill_tokens(64 * 1024, Duration::from_secs(1)), 65536);
        // 半秒拿一半。
        assert_eq!(refill_tokens(64 * 1024, Duration::from_millis(500)), 32768);
        // 低速档要保住小数：1 KiB/s 下 1ms 只有 1.024 字节 → 归整为 1；
        // 更短的时间窗不足 1 字节 → 0（宁可少给，不能白给）。
        assert_eq!(refill_tokens(1024, Duration::from_millis(1)), 1);
        assert_eq!(refill_tokens(1024, Duration::from_micros(500)), 0);
        assert_eq!(refill_tokens(1024, Duration::from_secs(1)), 1024);
        // 中间单位必须是微秒：1.5ms 若按毫秒截断会算成 65536*1/1000 = 65，
        // 每轮少给三分之一，唤醒密集的低速档会明显低于设定速率。
        assert_eq!(refill_tokens(64 * 1024, Duration::from_micros(1_500)), 98);
        // 不限速永远补不出令牌（调用方在 limit==0 时直接放行，不看这里）。
        assert_eq!(refill_tokens(0, Duration::from_secs(3600)), 0);
        // 极端值不溢出。
        let huge = refill_tokens(u64::MAX, Duration::from_secs(3600));
        assert!(huge > 0);
    }

    #[test]
    fn bucket_capacity_caps_the_burst() {
        assert_eq!(bucket_capacity(0), 0);
        // ~100ms 的突发量：限速 64 KiB/s 时起手最多多给 6.5 KiB，不会让限速形同虚设。
        assert_eq!(bucket_capacity(64 * 1024), 6553);
        assert_eq!(bucket_capacity(1_000_000), 100_000);
        // 至少 1 字节，否则极低限速下永远攒不出配额。
        assert_eq!(bucket_capacity(1), 1);
    }

    #[test]
    fn bucket_set_limit_recomputes_without_losing_track_of_time() {
        let mut b = Bucket::new(64);
        assert_eq!(b.limit_bps, 65536);
        b.set_limit(0);
        assert_eq!(b.limit_bps, 0);
        assert_eq!(b.tokens, 0);
        // 取消限速后重新限回来：容量按新速率算，令牌不残留旧速率的突发量。
        b.set_limit(1024);
        assert_eq!(b.limit_bps, 1024 * 1024);
        assert!(b.tokens <= bucket_capacity(b.limit_bps));
    }

    #[tokio::test]
    async fn throttle_actually_caps_wall_clock_time() {
        // 1 MiB/s 读 2 MiB：桶只允许 ~100ms 的突发，所以理论上要 ~1.9s。
        let b = Arc::new(Mutex::new(Bucket::new(1024)));
        let t0 = Instant::now();
        let mut left = 2u64 * 1024 * 1024;
        while left > 0 {
            let want = left.min(CHUNK);
            let grant = throttle(&b, want).await;
            assert!(grant > 0 && grant <= want, "want={want} grant={grant}");
            left -= grant;
        }
        let el = t0.elapsed().as_secs_f64();
        assert!(el >= 1.5, "限速 1 MiB/s 下 2 MiB 只用了 {el:.2}s，桶没起作用");
        assert!(el <= 4.0, "限速过头（不该慢成这样）：{el:.2}s");

        // 调回 0：立刻不等待。
        b.lock().await.set_limit(0);
        let t1 = Instant::now();
        for _ in 0..64 {
            assert_eq!(throttle(&b, CHUNK).await, CHUNK);
        }
        assert!(t1.elapsed() < Duration::from_millis(300), "取消限速后仍在等桶");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn throttle_bucket_is_shared_by_all_segments() {
        // 4 条「分段」共用同一个桶：总吞吐受同一个上限约束。
        // 如果是每段各限一份，2 MiB 总量只要 ~0.55s；共享桶则是 ~3.9s（上限 512 KiB/s）。
        let b = Arc::new(Mutex::new(Bucket::new(512)));
        let t0 = Instant::now();
        let mut hs = Vec::new();
        for _ in 0..4 {
            let b = b.clone();
            hs.push(tokio::spawn(async move {
                let mut left = 512 * 1024;
                while left > 0 {
                    left -= throttle(&b, left.min(CHUNK)).await;
                }
            }));
        }
        for h in hs {
            h.await.unwrap();
        }
        let el = t0.elapsed().as_secs_f64();
        assert!(el >= 3.0, "总耗时 {el:.2}s 太短：限速像是每段各限一份而不是共享");
        assert!(el <= 6.0, "共享桶慢得离谱：{el:.2}s");
    }

    // ---- 校验和解析 ----
    #[test]
    fn parse_checksum_accepts_documented_forms() {
        let h64 = "a".repeat(64);
        assert_eq!(parse_checksum("").unwrap(), None);
        assert_eq!(parse_checksum("   ").unwrap(), None);
        // 前缀式
        let c = parse_checksum(&format!("sha256:{h64}")).unwrap().unwrap();
        assert_eq!(c.alg, Alg::Sha256);
        assert_eq!(c.hex, h64);
        assert_eq!(c.display(), format!("sha256:{h64}"));
        // 前缀大小写不敏感、十六进制归一化成小写、空白容忍
        assert_eq!(
            parse_checksum(&format!(" SHA-256: {} ", "B".repeat(64))).unwrap().unwrap(),
            Checksum { alg: Alg::Sha256, hex: "b".repeat(64) }
        );
        assert_eq!(
            parse_checksum(&format!("Md5:{}", "c".repeat(32))).unwrap().unwrap().alg,
            Alg::Md5
        );
        assert_eq!(
            parse_checksum(&format!("SHA1:{}", "d".repeat(40))).unwrap().unwrap().alg,
            Alg::Sha1
        );
        // 裸 64 位十六进制按 sha256 处理
        assert_eq!(parse_checksum(&h64).unwrap().unwrap(), Checksum { alg: Alg::Sha256, hex: h64 });
    }

    #[test]
    fn parse_checksum_rejects_with_readable_error() {
        // 不认识的算法：给出可读信息，不panic、也不静默跳过校验。
        let e = parse_checksum("crc32:deadbeef").unwrap_err();
        assert!(e.starts_with("unsupported checksum algorithm: crc32"), "{e}");
        // 长度与算法不符
        let e = parse_checksum("sha256:deadbeef").unwrap_err();
        assert!(e.contains("64 hex digits") && e.contains("got 8"), "{e}");
        // 非十六进制
        assert!(parse_checksum(&format!("md5:{}", "z".repeat(32))).unwrap_err().contains("not hexadecimal"));
        // 裸十六进制只有 sha256 的长度才认
        let e = parse_checksum(&"a".repeat(32)).unwrap_err();
        assert!(e.contains("needs an algorithm prefix"), "{e}");
        // 只写了前缀没写值：空串对十六进制检查是「真空」（all 对空迭代器为 true），
        // 所以由长度检查兜住，文案同样能读懂。
        let e = parse_checksum("sha256:").unwrap_err();
        assert!(e.contains("64 hex digits") && e.contains("got 0"), "{e}");
    }

    /// 一次性哈希内存缓冲，逐字节 `{b:02x}`——和 `hash_file` 的出串方式完全一致，
    /// 这样两边比较才有意义（不能让被测方用一种十六进制实现、参照方用另一种）。
    fn hex_once<D: Digest>(bytes: &[u8]) -> String {
        let mut h = D::new();
        h.update(bytes);
        h.finalize().iter().map(|b| format!("{b:02x}")).collect()
    }

    #[tokio::test]
    async fn hash_file_matches_known_vectors_and_chunks() {
        let dir = std::env::temp_dir().join(format!("fastdrop-engine-hash-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("h.bin");
        std::fs::write(&p, b"abc").unwrap();
        let path = p.to_str().unwrap();
        // 三个算法的经典向量：同时验证出串没有把前导零吞掉（"0a" 不会写成 "a"）。
        assert_eq!(
            hash_file::<sha2::Sha256>(path).await.unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            hash_file::<sha1::Sha1>(path).await.unwrap(),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
        assert_eq!(
            hash_file::<md5::Md5>(path).await.unwrap(),
            "900150983cd24fb0d6963f7d28e17f72"
        );
        // 跨多个读缓冲：分块 update 与一次性 digest 必须逐字节一致。
        // 数据里刻意含 0x00~0x0f 这类高位为零的字节，前导零一旦丢了这里就挂。
        let big: Vec<u8> = (0..(3 * HASH_BUF as u32 + 7))
            .map(|i| ((i.wrapping_mul(2654435761)) >> 13) as u8)
            .collect();
        assert!(big.iter().any(|&b| b < 0x10), "测试数据得含前导零字节才测得出格式问题");
        std::fs::write(&p, &big).unwrap();
        assert_eq!(hash_file::<sha2::Sha256>(path).await.unwrap(), hex_once::<sha2::Sha256>(&big));
        assert_eq!(hash_file::<sha1::Sha1>(path).await.unwrap(), hex_once::<sha1::Sha1>(&big));
        assert_eq!(hash_file::<md5::Md5>(path).await.unwrap(), hex_once::<md5::Md5>(&big));
        // 文件不存在 → 可读错误，不是 panic。
        let miss = dir.join("nope.bin");
        let e = hash_file::<sha2::Sha256>(miss.to_str().unwrap()).await.unwrap_err();
        assert!(e.contains("nope.bin"), "{e}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn run_verify_reports_mismatch_with_both_digests() {
        let dir = std::env::temp_dir().join(format!("fastdrop-engine-verify-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("v.bin");
        std::fs::write(&p, b"abc").unwrap();
        let cs = parse_checksum("md5:900150983cd24fb0d6963f7d28e17f72").unwrap().unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        run_verify(cs.clone(), p.to_str().unwrap().to_string(), 7, 1, tx).await;
        let r = rx.recv().await.unwrap();
        assert_eq!((r.task_id, r.gen), (7, 1));
        assert_eq!(r.error, None, "正确的校验和不该报错");
        // 故意写错：文案必须同时给出期望值和实际值，用户才有得判断。
        let bad = Checksum { alg: Alg::Md5, hex: "0".repeat(32) };
        let (tx, mut rx) = mpsc::unbounded_channel();
        run_verify(bad, p.to_str().unwrap().to_string(), 7, 1, tx).await;
        let e = rx.recv().await.unwrap().error.unwrap();
        assert!(
            e == "checksum mismatch: expected md5:00000000000000000000000000000000, \
                got md5:900150983cd24fb0d6963f7d28e17f72",
            "{e}"
        );
        // 文件读不到时是「verify failed」而不是「mismatch」——两者对用户的处置完全不同。
        let (tx, mut rx) = mpsc::unbounded_channel();
        run_verify(cs, dir.join("gone.bin").to_str().unwrap().to_string(), 7, 1, tx).await;
        let e = rx.recv().await.unwrap().error.unwrap();
        assert!(e.starts_with("checksum verify failed:"), "{e}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- set_threads 区间交集（对应缺陷 3：把重叠区当已下载区，虚高进度）----
    #[test]
    fn recompute_single_old_partial_into_two_new() {
        // 老单段 [0,999] 只下了前 500 字节（真实区间 [0,500)）。
        let old = vec![(0u64, 999u64, 500u64)];
        assert_eq!(recompute_segment(0, 499, &old), 500); // 新段 0 全部落在已下载区
        assert_eq!(recompute_segment(500, 999, &old), 0); // 新段 1 一个字节都没有
        // 旧算法这里会给新段 1 报 500（min(500, 500 overlap)），虚高。
    }

    #[test]
    fn recompute_partial_overlap_straddles_boundary() {
        // 老段 [0,199] 下了 150（区间 [0,150)）；新段 [100,149] 完全在已下载内。
        assert_eq!(recompute_segment(100, 149, &[(0, 199, 150)]), 50);
        // 新段 [120,180]：已下载区 [0,150) 与之交 [120,150) = 30。
        assert_eq!(recompute_segment(120, 180, &[(0, 199, 150)]), 30);
    }

    #[test]
    fn recompute_multiple_old_segments_disjoint() {
        // 老 4 段：段 0 满、段 1 满、段 2 半、段 3 空。合并到新单段 [0, 3999] 应等于总下载量。
        let old = vec![(0u64, 999u64, 1000u64), (1000, 1999, 1000), (2000, 2999, 500), (3000, 3999, 0)];
        assert_eq!(recompute_segment(0, 3999, &old), 2500);
        // 新段 [2400,3099]：段2已下载区 [2000,2500) 交得 [2400,2500)=100；段3无。
        assert_eq!(recompute_segment(2400, 3099, &old), 100);
    }
}
