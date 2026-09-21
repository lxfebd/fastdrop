//! FastDrop 的 native messaging 宿主（Chrome/Edge 扩展的本地通道）。
//!
//! 为什么宿主必须是独立原生进程而不是 Electron 本身：扩展一发
//! sendNativeMessage，浏览器用 `chrome-extension://<id>` 当 argv[0] 拉起宿主。
//! Electron 在这种启动方式下 app ready 事件不可靠，且 ready 之前任何
//! 原生调用（readSync / http / spawn / getPath）都会触发 Chromium CHECK 崩溃
//! （STATUS_BREAKPOINT，实测）。Rust 没有这一层——读管道、HTTP、拉起进程
//! 全是标准库直连，这也是 IDM / Motrix / aria2 浏览器扩展的标准做法。
//!
//! 职责：
//!   1. 从 stdin 读一帧（4 字节小端长度 + UTF-8 JSON）
//!   2. 读收件箱凭据（env FASTDROP_INBOX_FILE，或 LOCALAPPDATA/FastDrop/inbox.json）
//!   3. POST 到 127.0.0.1:port/add 把 URL 投给主 FastDrop 实例
//!   4. 连不上（主实例没开）→ spawn 主实例 fastdrop.exe --inbox-add <url>
//!   5. 把结果回一帧到 stdout，退出（0 = 成功）
//!
//! 帧协议与 Chromium 扩展的 sendNativeMessage 完全一致。

use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const MAX_FRAME: usize = 1024 * 1024;

fn read_exact_n(n: usize) -> Option<Vec<u8>> {
    let mut out = vec![0u8; n];
    let mut off = 0usize;
    while off < n {
        let got = std::io::stdin().read(&mut out[off..]).ok()?;
        if got == 0 {
            return None; // EOF：浏览器关了管道
        }
        off += got;
    }
    Some(out)
}

fn write_frame(obj: &serde_json::Value) {
    let text = serde_json::to_string(obj).unwrap_or_else(|_| "{\"ok\":false}".into());
    let n = text.len();
    let mut buf = Vec::with_capacity(4 + n);
    buf.extend_from_slice(&(n as u32).to_le_bytes());
    buf.extend_from_slice(text.as_bytes());
    let mut out = std::io::stdout();
    let _ = out.write_all(&buf);
    let _ = out.flush();
}

/// 收件箱凭据：显式 env 优先（测试隔离），否则 LOCALAPPDATA/FastDrop/inbox.json。
fn load_inbox_info() -> Option<(u16, String)> {
    let mut path = env::var("FASTDROP_INBOX_FILE").ok().map(PathBuf::from);
    if path.is_none() {
        let local = env::var("LOCALAPPDATA")
            .or_else(|_| env::var("USERPROFILE").map(|h| format!("{}\\AppData\\Local", h)))
            .ok()?;
        path = Some(PathBuf::from(local).join("FastDrop").join("inbox.json"));
    }
    let p = path?;
    let raw = fs::read_to_string(p).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let port = v.get("port")?.as_u64()? as u16;
    let token = v.get("token")?.as_str()?.to_string();
    if port == 0 {
        return None;
    }
    Some((port, token))
}

/// 手写 HTTP/1.1 POST 到收件箱。返回解析后的 JSON 响应；连不上返回 None。
fn post_inbox(port: u16, token: &str, body: &[u8]) -> Option<serde_json::Value> {
    let addr = format!("127.0.0.1:{}", port);
    let mut stream = TcpStream::connect(&addr).ok()?;
    stream.set_read_timeout(Some(std::time::Duration::from_millis(2500))).ok()?;
    stream.set_write_timeout(Some(std::time::Duration::from_millis(2500))).ok()?;

    let req = format!(
        "POST /add HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        port,
        token,
        body.len()
    );
    stream.write_all(req.as_bytes()).ok()?;
    stream.write_all(body).ok()?;
    let _ = stream.flush();

    let mut resp = Vec::new();
    let _ = stream.read_to_end(&mut resp);
    // 找 body 起点（\r\n\r\n 之后）
    let pos = resp
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|p| p + 4)?;
    let payload = &resp[pos..];
    // body 可能带 chunked 或直接是 JSON；native 环境只关心 JSON，直接尝试解析
    serde_json::from_slice(payload).ok()
}

/// 拉起主 FastDrop 实例，把 URL 交给它。userData 可选（宿主侧不传）。
fn spawn_main(url: &str, user_data: &str) {
    // host exe 在 <安装目录>/resources/，主实例 exe 在上一级
    // （resources 是 electron-builder extraResources 的目标目录）。
    let exe = match env::current_exe() {
        Ok(p) => {
            let resources = p.parent().unwrap_or(Path::new("."));
            let root = resources.parent().unwrap_or(resources);
            root.join("fastdrop.exe")
        }
        Err(_) => return,
    };
    if !exe.exists() {
        // e.g. running host from target/release directly in dev — main exe is far away; give up silently
        return;
    }
    let mut cmd = Command::new(exe);
    if !user_data.is_empty() {
        cmd.arg(format!("--user-data-dir={}", user_data));
    }
    cmd.arg("--inbox-add").arg(url);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS：脱离宿主生命周期
        cmd.creation_flags(0x00000208);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let _ = cmd.spawn(); // 失败也静默：至少回帧 ok，用户看到的是窗口没弹
}

fn main() {
    // 参数解析：--user-data-dir=<x>（宿主 side 会在 ready 前拿不到 app.getPath，
    // 一般传空；保留这个开关是为了测试隔离能透传）。
    let mut user_data = String::new();
    for arg in env::args().skip(1) {
        if let Some(v) = arg.strip_prefix("--user-data-dir=") {
            user_data = v.to_string();
        }
    }

    // 1. 读帧
    let Some(header) = read_exact_n(4) else {
        write_frame(&serde_json::json!({"ok": false, "error": "stdin closed before frame"}));
        std::process::exit(1);
    };
    let len = u32::from_le_bytes([header[0], header[1], header[2], header[3]]) as usize;
    if len == 0 || len > MAX_FRAME {
        write_frame(&serde_json::json!({"ok": false, "error": "frame too large"}));
        std::process::exit(1);
    }
    let Some(body) = read_exact_n(len) else {
        write_frame(&serde_json::json!({"ok": false, "error": "truncated frame"}));
        std::process::exit(1);
    };
    let parsed: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            write_frame(&serde_json::json!({"ok": false, "error": "bad json in frame"}));
            std::process::exit(1);
        }
    };
    let url = parsed
        .get("url")
        .and_then(|u| u.as_str())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let is_http = url.starts_with("http://") || url.starts_with("https://") || url.starts_with("ftp://");
    if !is_http {
        write_frame(&serde_json::json!({"ok": false, "error": "invalid url"}));
        std::process::exit(1);
    }
    let threads = parsed.get("threads").and_then(|t| t.as_u64());
    let note = parsed.get("note").and_then(|n| n.as_str()).unwrap_or("").to_string();
    let mut payload = serde_json::json!({"url": url});
    if let Some(t) = threads {
        payload["threads"] = serde_json::json!(t);
    }
    if !note.is_empty() {
        payload["note"] = serde_json::json!(note);
    }

    // 2. 投递
    let info = load_inbox_info();
    let result = match info {
        Some((port, token)) => {
            let body = serde_json::to_vec(&payload).unwrap_or_default();
            post_inbox(port, &token, &body)
        }
        None => None,
    };

    // 3. 连不上 → 拉起主实例，回 ok
    match result {
        Some(v) => {
            write_frame(&v);
            let ok = v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false);
            std::process::exit(if ok { 0 } else { 1 });
        }
        None => {
            spawn_main(&url, &user_data);
            write_frame(&serde_json::json!({"ok": true}));
            std::process::exit(0);
        }
    }
}