"""Rust 引擎端到端测试：起本地 HTTP 服务，通过 stdio JSON 协议验证。

覆盖：
1. 支持 Range  -> 多段并发下载，校验 md5
2. 不支持 Range -> 单线程回退，校验 md5
3. 断点续传 -> 手写 sidecar 偏移，引擎只补剩余字节
4. 非法 URL -> 返回 error 事件
5. 限速 -> 实测墙钟耗时 ≥ 设定值算出的下限，且一个任务内所有分段共用同一个桶
6. 未知长度（chunked）-> 全程单流顺序下完，done 时回填真实字节数，且不支持续传
7. 校验和 -> 校验通过才 rename；不通过保留 .part 并报 checksum mismatch

不联网、不依赖 Qt：`py tests/test_engine_rs.py`（Windows 上 `python` 可能不在 PATH，
用启动器 `py`；先 `cd engine-rs && cargo build --release`，用例跑的是那个产物）。
"""
from __future__ import annotations

import hashlib
import http.server
import json
import socketserver
import subprocess
import sys
import threading
import time
from pathlib import Path

# Windows runner（英文区域）默认 stdout 是 cp1252，中文用例名 print 即崩；
# Linux/macOS 是 utf-8 不受影响。强制输出走 utf-8，与仓库内其他测试保持一致。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
EXE = ROOT / "engine-rs" / "target" / "release" / ("fastdrop-engine.exe" if sys.platform == "win32" else "fastdrop-engine")
TMP = ROOT / "tests" / "_tmp_rs"

# 位置相关的非周期内容。旧数据是 21 字节循环串，续传点 K 恰为周期整数倍时，
# 「把整份文件错位写到偏移 K」的结果会和正确数据逐字节相同 → md5 看不出损坏，
# 缺陷 1/2 的回归用例形同虚设。这里改成随位置变化、无短周期的字节序列，让任何
# 错位/空洞都会真实改变 md5。
_N = 4_000_000   # 能被 2/4/8 整除；> 8 * MIN_SEGMENT(256 KiB)，支持 8 线程分段
DATA = bytes((((i * 2654435761) >> 24) ^ (i >> 8) ^ i) & 0xFF for i in range(_N))
EXPECT_MD5 = hashlib.md5(DATA).hexdigest()
EXPECT_SHA256 = hashlib.sha256(DATA).hexdigest()
EXPECT_SHA1 = hashlib.sha1(DATA).hexdigest()

# 限速用例的正文。为什么不用 DATA：4 MB 在限速下要几十秒，用例不能跑那么久。
# 但也不能太小——引擎按 `total / MIN_SEGMENT(256 KiB)` 夹紧线程数，正文小于 1 MiB 时
# 就算 probe 写了 threads=4 也只会切成 1 段，那样「一个桶被所有分段共享」这条语义
# 根本没被跑到（每段各一份配额 = 只有一份配额，看不出区别）。
# 取 1 MiB + 零头：4 段成立，且 1032 KiB / 256 KiB·s⁻¹ ≈ 4.0 秒——
# 如果是「每段各限一份」，4 段并行只要约 1 秒，两者的差距足够大到不会被机器速度蒙混。
_RATE_N = 1_053_576   # = 4 * 256 KiB + 8192，非整数倍长度，多写/少写一字节都会改 md5
RATE_BODY = DATA[:_RATE_N]
RATE_MD5 = hashlib.md5(RATE_BODY).hexdigest()
RATE_KBPS = 256  # KiB/s
RATE_FLOOR = len(RATE_BODY) / (RATE_KBPS * 1024)  # 理论最快耗时（秒）

# 未知长度用例的正文。故意取一个不整不齐的长度：截断/多写一个字节都会改变 md5。
_CHUNK_N = 3_000_777
CHUNK_BODY = DATA[:_CHUNK_N]
CHUNK_MD5 = hashlib.md5(CHUNK_BODY).hexdigest()

PORT = 18873
PORT_NO_RANGE = 18874
PORT_LIE = 18875
PORT_PSEUDO = 18876
PORT_416 = 18877
PORT_RATE = 18878
PORT_CHUNKED = 18879

# chunked 服务器记录是否收到过 Range 请求头。未知长度必须走「整份顺序读」，
# 一旦发出 Range，服务端要么忽略（我们拿不到想要的区间）要么 416，两条路都是坑。
RANGE_SEEN: list[str] = []


class RangeHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, write_body: bool):
        rng = self.headers.get("Range")
        if rng:
            a, b = rng.split("=")[1].split("-")
            start, end = int(a), int(b)
            body = DATA[start:end + 1]
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{len(DATA)}")
        else:
            body = DATA
            self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Type", "application/octet-stream")
        self.end_headers()
        if write_body:
            self.wfile.write(body)

    def do_GET(self):
        self._send(True)

    def do_HEAD(self):
        self._send(False)


class NoRangeHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, write_body: bool):
        self.send_response(200)
        self.send_header("Content-Length", str(len(DATA)))
        self.send_header("Content-Type", "application/octet-stream")
        # 故意不返回 Accept-Ranges
        self.end_headers()
        if write_body:
            self.wfile.write(DATA)

    def do_GET(self):
        self._send(True)

    def do_HEAD(self):
        self._send(False)


class LyingRangeHandler(http.server.BaseHTTPRequestHandler):
    """206，但把 Content-Range 的区间起点谎报成 0（无视我们请求的 from），并给足
    Content-Length 让 reqwest 认为响应体完整。

    旧实现 `declared_len` 里解析 Content-Range 的代码是死路（该头没有 '='），于是
    引擎根本不看 Content-Range，把「其实从 0 开始」的正文写到我们的 from 偏移 → 段被判
    完成 → 整个成品错位损坏并发 done。修好后必须校验 first == from，不符即判失败。
    """
    def log_message(self, *a):
        pass

    def _send(self, write_body: bool):
        rng = self.headers.get("Range")
        if rng:
            a, b = rng.split("=")[1].split("-")
            start, end = int(a), int(b)
            length = end - start + 1
            self.send_response(206)
            # 谎报：区间起点恒为 0，正文也是 DATA[0:length]（对 from>0 的段是错位内容）。
            self.send_header("Content-Range", f"bytes 0-{length - 1}/{len(DATA)}")
            self.send_header("Content-Length", str(length))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Type", "application/octet-stream")
            self.end_headers()
            if write_body:
                self.wfile.write(DATA[0:length])
        else:
            self.send_response(200)
            self.send_header("Content-Length", str(len(DATA)))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Type", "application/octet-stream")
            self.end_headers()
            if write_body:
                self.wfile.write(DATA)

    def do_GET(self):
        self._send(True)

    def do_HEAD(self):
        self._send(False)


class PseudoRangeHandler(http.server.BaseHTTPRequestHandler):
    """挂着 `Accept-Ranges: bytes` 却彻底无视 Range —— 无论怎么请求都回 200 整份文件。

    这是现实中真实存在的一类服务器（部分 CDN/对象存储的兼容层）。它的杀伤力在于
    「探测说能分段、正文却不分段」：引擎按 Accept-Ranges 判可分段 → 切多段 → 每个
    from>0 的段都撞上 fetch 层的「server ignored Range」→ 归零重下 → 连试 3 次升级
    fatal → 用户看到的就是一句「下载失败」。正确做法是只认真正的 206，退回单线程。
    """
    def log_message(self, *a):
        pass

    def _send(self, write_body: bool):
        self.send_response(200)
        self.send_header("Content-Length", str(len(DATA)))
        self.send_header("Accept-Ranges", "bytes")  # 声称支持，实则从不返回 206
        self.send_header("Content-Type", "application/octet-stream")
        self.end_headers()
        if write_body:
            self.wfile.write(DATA)

    do_GET = lambda self: self._send(True)
    do_HEAD = lambda self: self._send(False)


class Always416Handler(http.server.BaseHTTPRequestHandler):
    """HEAD 报出完整长度，但任何带 Range 的 GET 一律 416。

    模拟「服务器自己兑现不了它声明的区间」（文件被换小、边缘节点缺分片）。这类坏
    服务器必须换来一条可读的 error，而不是静默残缺、错位或把半截 .part 改名成成品。
    """
    def log_message(self, *a):
        pass

    def _reply(self, write_body: bool):
        if self.headers.get("Range"):
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{len(DATA) // 2}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Length", str(len(DATA)))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Type", "application/octet-stream")
        self.end_headers()
        if write_body:
            self.wfile.write(DATA)

    do_GET = lambda self: self._reply(True)
    do_HEAD = lambda self: self._reply(False)


class RangeBodyHandler(http.server.BaseHTTPRequestHandler):
    """支持 Range 的服务器，但正文长度由子类的 `body` 决定。

    限速用例需要一个「按设定限速就要跑几秒、不限速就几十毫秒」的小文件；
    直接复用全局 DATA（4 MB）会让用例耗时变成 40 秒，所以把长度参数化。
    """
    body: bytes = DATA

    def log_message(self, *a):
        pass

    def _send(self, write_body: bool):
        rng = self.headers.get("Range")
        body = type(self).body
        if rng:
            a, b = rng.split("=")[1].split("-")
            start, end = int(a), min(int(b), len(body) - 1)
            out = body[start:end + 1]
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{len(body)}")
        else:
            out = body
            self.send_response(200)
        self.send_header("Content-Length", str(len(out)))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Type", "application/octet-stream")
        self.end_headers()
        if write_body:
            self.wfile.write(out)

    do_GET = lambda self: self._send(True)
    do_HEAD = lambda self: self._send(False)


class ChunkedHandler(http.server.BaseHTTPRequestHandler):
    """报不出长度的流式接口：HEAD 不给 Content-Length，GET 用 chunked 分块吐正文。

    真实世界里这类地址不少（动态打包、导出接口、部分 CDN 回源）。它考验的是引擎
    对「连得上、也正常应答，但问不出多大」的处理：必须当成**可下载**退化成单流
    顺序读，而不是当成探测失败直接报错——否则用户手上只有这种链接就永远下不了。
    """
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def do_HEAD(self):
        if self.headers.get("Range"):
            RANGE_SEEN.append("HEAD " + self.headers.get("Range"))
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        # 既不写 Content-Length，也不写 Accept-Ranges：长度问不出，区间不支持。
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

    def do_GET(self):
        if self.headers.get("Range"):
            RANGE_SEEN.append("GET " + self.headers.get("Range"))
        self.send_response(200)
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Content-Type", "application/octet-stream")
        self.end_headers()
        step = 61 * 1024  # 故意用不整齐的块大小，逼引擎正确拼接分块
        body = CHUNK_BODY
        # 每块之间稍停一下：本机回环下 3 MB 只要几十毫秒，整场下载连一次 100ms
        # 推进快照都凑不满，「中途也始终是单流 / total 未知时 progress 恒为 0」
        # 这类逐快照断言就成了空断言。放慢到约 1 秒，中间快照就有了。
        for i in range(0, len(body), step):
            chunk = body[i:i + step]
            self.wfile.write(b"%x\r\n" % len(chunk) + chunk + b"\r\n")
            self.wfile.flush()
            time.sleep(0.02)
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()


def serve(handler, port: int) -> http.server.HTTPServer:
    cls = type("S", (socketserver.ThreadingMixIn, http.server.HTTPServer),
               {"allow_reuse_address": True, "daemon_threads": True})
    srv = cls(("127.0.0.1", port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


class Session:
    """一个引擎子进程会话，线程安全地收发 JSON 行。"""

    def __init__(self):
        self.p = subprocess.Popen(
            [str(EXE)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        self.ev: list[dict] = []
        self.lock = threading.Lock()
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        try:
            for raw in self.p.stdout:
                s = raw.decode("utf-8", "replace").strip()
                if s:
                    try:
                        msg = json.loads(s)
                    except ValueError:
                        continue
                    with self.lock:
                        self.ev.append(msg)
        except OSError:
            pass

    def send(self, **kw) -> None:
        self.p.stdin.write((json.dumps(kw) + "\n").encode())
        self.p.stdin.flush()

    def send_raw(self, data: bytes) -> None:
        """直接往 stdin 灌原始字节（含非法 UTF-8），绕过 json 编码。"""
        self.p.stdin.write(data)
        self.p.stdin.flush()

    def wait_for(self, predicate, timeout: float = 40.0) -> bool:
        t0 = time.time()
        while time.time() - t0 < timeout:
            with self.lock:
                if any(predicate(m) for m in self.ev):
                    return True
            if self.p.poll() is not None:
                return False
            time.sleep(0.05)
        return False

    def last_progress(self) -> dict:
        with self.lock:
            prog = [m for m in self.ev if m.get("event") == "progress"]
        return prog[-1]["data"] if prog else {}

    def close(self):
        try:
            if self.p.poll() is None:
                self.p.stdin.close()
                self.p.terminate()
                self.p.wait(timeout=5)
        except OSError:
            pass
        try:
            self.p.kill()
        except OSError:
            pass


def md5(p: Path) -> str:
    return hashlib.md5(p.read_bytes()).hexdigest()


def cleanup(name: str):
    d = TMP / name
    for suffix in ("", ".part", ".part.meta"):
        try:
            (d / ("out" + suffix)).unlink()
        except OSError:
            pass

def test_ranges():
    s = serve(RangeHandler, PORT)
    cleanup("ranges")
    dest = str(TMP / "ranges" / "out.bin")
    se = Session()
    try:
        se.send(cmd="probe", url=f"http://127.0.0.1:{PORT}/f.bin",
                dest=dest, threads=8, proxy="", user_agent="")
        assert se.wait_for(lambda m: m.get("event") == "progress"
                           and m.get("data", {}).get("total")), "probe 没返回 total"
        snap = se.last_progress()
        assert snap["total"] == len(DATA), f"total={snap['total']}"
        assert snap["threads"] == 8, f"threads={snap['threads']} (Range 支持却没分段)"
        assert len(snap["segments"]) == 8
        se.send(cmd="run")
        assert se.wait_for(lambda m: m.get("event") == "done"), "没有 done 事件"
        f = Path(dest)
        assert f.exists(), "目标文件不存在"
        assert md5(f) == EXPECT_MD5, "md5 不匹配"
        assert not Path(dest + ".part").exists(), ".part 应被移除"
        assert not Path(dest + ".part.meta").exists(), "sidecar 应被移除"
        with se.lock:
            assert any(m.get("event") == "error" for m in se.ev) is False, "不该有 error"
        return "分段并发下载"
    finally:
        se.close()
        s.shutdown()


def test_no_ranges():
    s = serve(NoRangeHandler, PORT_NO_RANGE)
    cleanup("noranges")
    dest = str(TMP / "noranges" / "out.bin")
    se = Session()
    try:
        se.send(cmd="probe", url=f"http://127.0.0.1:{PORT_NO_RANGE}/f.bin",
                dest=dest, threads=8, proxy="", user_agent="")
        assert se.wait_for(lambda m: m.get("event") in ("progress", "done")), "没响应"
        # probe 与 run 是两条命令；probe 之后 state 停在 idle，必须补发 run。
        # 不能用 last_progress 判断是否已下载——快服务器可能还没 run 就已完成。
        snap = se.last_progress()
        if "threads" in snap:
            assert snap["threads"] == 1, f"不支持 Range 时应单线程，实际 {snap['threads']}"
        se.send(cmd="run")
        assert se.wait_for(lambda m: m.get("event") == "done"), "没有 done 事件"
        assert md5(Path(dest)) == EXPECT_MD5, "md5 不匹配"
        final = se.last_progress()
        if "threads" in final:
            assert final["threads"] == 1
        return "不支持 Range 单线程回退"
    finally:
        se.close()
        s.shutdown()


def test_resume():
    s = serve(RangeHandler, PORT)
    cleanup("resume")
    dest = str(TMP / "resume" / "out.bin")
    p = Path(dest)
    seg = len(DATA) // 4
    part = p.with_suffix(p.suffix + ".part")
    part.parent.mkdir(parents=True, exist_ok=True)
    # 段 0、1 完整，段 2 半满，段 3 空
    part.write_bytes(DATA[:2 * seg] + DATA[2 * seg:2 * seg + seg // 2])
    meta = p.with_suffix(p.suffix + ".part.meta")
    meta.write_text(json.dumps({
        "url": f"http://127.0.0.1:{PORT}/f.bin",
        "total": len(DATA), "threads": 4,
        "segments": {"0": seg, "1": seg, "2": seg // 2, "3": 0},
    }), encoding="utf-8")
    se = Session()
    try:
        se.send(cmd="probe", url=f"http://127.0.0.1:{PORT}/f.bin",
                dest=dest, threads=4, proxy="", user_agent="")
        assert se.wait_for(lambda m: m.get("event") in ("progress", "done")), "没响应"
        want = 2 * seg + seg // 2
        # probe 之后引擎还没开始下载（不会自动 run），所以这里的快照一定是
        # probe 的结果——正是检查“是否从 sidecar 恢复了偏移”的地方。
        snap = se.last_progress()
        assert snap.get("threads") == 4, f"threads={snap.get('threads')}"
        assert snap.get("downloaded") == want,             f"续传起点 {snap.get('downloaded')} != {want}"
        se.send(cmd="run")
        assert se.wait_for(lambda m: m.get("event") == "done"), "没有 done 事件"
        final = se.last_progress()
        assert final.get("downloaded") == len(DATA),             f"最终下载量 {final.get('downloaded')} != {len(DATA)}"
        assert md5(p) == EXPECT_MD5, "续传后 md5 不匹配"
        return "断点续传"
    finally:
        se.close()
        s.shutdown()


def test_bad_url():
    se = Session()
    try:
        dest = str(TMP / "bad" / "out.bin")
        se.send(cmd="probe", url="http://127.0.0.1:1/nope.bin",
                dest=dest, threads=4, proxy="", user_agent="")
        assert se.wait_for(lambda m: m.get("event") == "error"), "没有 error 事件"
        with se.lock:
            errs = [m for m in se.ev if m.get("event") == "error"]
        assert errs and errs[-1].get("error"), "error 事件为空"
        return "错误上报"
    finally:
        se.close()


def wipe(dest: str):
    """按完整 dest 路径删掉成品及其 .part/.part.meta（现有 cleanup 只清 'out' 不带
    .bin 扩展名，会漏掉 out.bin，导致「断言成品不存在」的用例被上一轮残留文件误判）。"""
    for suf in ("", ".part", ".part.meta"):
        try:
            Path(dest + suf).unlink()
        except OSError:
            pass


def _write_part(dest: str, prefix_len: int):
    """写一个长度=total 的 .part：前 prefix_len 字节是正确内容，其余留空洞。
    长度刻意等于 total，好让 ensure_part 判「完好、不清零」，从而逼引擎真按边车偏移续传。"""
    p = Path(dest)
    p.parent.mkdir(parents=True, exist_ok=True)
    total = len(DATA)
    part = p.with_suffix(p.suffix + ".part")
    part.write_bytes(DATA[:prefix_len] + b"\x00" * (total - prefix_len))
    return part


def _write_meta(dest: str, url: str, threads: int, offsets: dict):
    p = Path(dest)
    p.parent.mkdir(parents=True, exist_ok=True)
    meta = p.with_suffix(p.suffix + ".part.meta")
    meta.write_text(json.dumps({
        "url": url, "total": len(DATA), "threads": threads,
        "segments": {str(k): v for k, v in offsets.items()},
    }), encoding="utf-8")
    return meta


# (a) 缺陷 1：服务器无视 Range、且续传起点 from>0 时，不得把整份文件写到 from 偏移。
def test_no_range_resume_from_offset():
    s = serve(NoRangeHandler, PORT_NO_RANGE)
    cleanup("nrz")
    dest = str(TMP / "nrz" / "out.bin")
    url = f"http://127.0.0.1:{PORT_NO_RANGE}/f.bin"
    K = len(DATA) // 2
    wipe(dest)
    _write_part(dest, K)                       # 长度=total，前 K 字节正确
    _write_meta(dest, url, 1, {0: K})          # 单段，续传点=K>0
    se = Session()
    try:
        se.send(cmd="probe", url=url, dest=dest, threads=8, proxy="", user_agent="")
        assert se.wait_for(lambda m: m.get("event") == "progress"
                           and m.get("data", {}).get("total")), "probe 无响应"
        snap = se.last_progress()
        assert snap.get("threads") == 1, "无 Range 应单线程"
        assert snap.get("downloaded") == K, f"probe 后进度 {snap.get('downloaded')} != {K}"
        se.send(cmd="run")
        assert se.wait_for(lambda m: m.get("event") == "done", timeout=60), "没有 done 事件"
        # 旧行为：整份文件被写到偏移 K，整体错位 → md5 不匹配。
        assert md5(Path(dest)) == EXPECT_MD5, "无视 Range 时从偏移续传导致文件损坏"
        return "无视 Range + from>0 续传不损坏"
    finally:
        se.close()
        s.shutdown()


# (b) 缺陷 2：Content-Range 解析生效 → 服务器返回与请求 from 不符的区间必须判失败，
#     绝不把「其实从 0 开始」的正文写到 from 偏移 rename 成错位成品。
#     （提前断链的 last-first+1 长度校验由 Rust 单元测试 expected_len 覆盖：旧 declared_len
#      用 split('=') 解析没有 '=' 的 Content-Range 是死代码，只能退回 Content-Length。）
def test_content_range_mismatch_rejected():
    s = serve(LyingRangeHandler, PORT_LIE)
    dest = str(TMP / "lierc" / "out.bin")
    wipe(dest)
    se = Session()
    try:
        se.send(cmd="probe", url=f"http://127.0.0.1:{PORT_LIE}/f.bin",
                dest=dest, threads=8, proxy="", user_agent="")
        assert se.wait_for(lambda m: m.get("event") == "progress"
                           and m.get("data", {}).get("total")), "probe 无响应"
        # Range 可用（有 206），会被切成多段；非首段 from>0 撞上 first!=from。
        se.send(cmd="run")
        assert se.wait_for(lambda m: m.get("event") == "error", timeout=60), "区间不符没被判失败"
        with se.lock:
            assert not any(m.get("event") == "done" for m in se.ev), "错位数据被当成完成并发 done"
        assert not Path(dest).exists(), "错位/损坏的 .part 被 rename 成了成品"
        return "Content-Range 区间不符被拒绝"
    finally:
        se.close()
        s.shutdown()


# (c) 缺陷 3：中途改线程数按「已下载字节区间」求交集，不虚高进度、不损坏成品。
def test_set_threads_midflight():
    s = serve(RangeHandler, PORT)
    cleanup("setth")
    dest = str(TMP / "setth" / "out.bin")
    url = f"http://127.0.0.1:{PORT}/f.bin"
    K = 3_500_000                              # 跨过 4 线程布局里多个段边界（seg=1_000_000）
    wipe(dest)
    _write_part(dest, K)                       # 长度=total（真实单段续传后已 set_len 到全长）
    _write_meta(dest, url, 1, {0: K})          # 老布局：单段，已下 K
    se = Session()
    try:
        se.send(cmd="probe", url=url, dest=dest, threads=1, proxy="", user_agent="")
        assert se.wait_for(lambda m: m.get("event") == "progress"
                           and m.get("data", {}).get("total")), "probe 无响应"
        snap = se.last_progress()
        assert snap.get("threads") == 1, f"probe threads={snap.get('threads')}"
        assert snap.get("downloaded") == K, f"probe 后进度 {snap.get('downloaded')} != {K}"
        # 1 -> 4：旧算法把重叠区当已下载区，会把总进度虚报成满（=数据损坏根因）。
        se.send(cmd="set_threads", n=4)
        assert se.wait_for(lambda m: m.get("event") == "progress"
                           and m.get("data", {}).get("threads") == 4), "set_threads 未生效"
        snap = se.last_progress()
        assert snap.get("threads") == 4, f"改线程数后 threads={snap.get('threads')}"
        assert snap.get("downloaded") == K,             f"改线程数后进度 {snap.get('downloaded')} != 真实 {K}（虚高）"
        se.send(cmd="run")
        assert se.wait_for(lambda m: m.get("event") == "done", timeout=60), "没有 done 事件"
        assert md5(Path(dest)) == EXPECT_MD5, "改线程数续传后 md5 不匹配"
        return "中途改线程数不虚高进度"
    finally:
        se.close()
        s.shutdown()


# (d) 缺陷 4：任务已 done 后再收到 run，绝不重建全零 .part 覆盖成品（幂等）。
def test_run_after_done_idempotent():
    s = serve(RangeHandler, PORT)
    cleanup("rad")
    dest = str(TMP / "rad" / "out.bin")
    wipe(dest)
    se = Session()
    try:
        se.send(cmd="probe", url=f"http://127.0.0.1:{PORT}/f.bin",
                dest=dest, threads=8, proxy="", user_agent="")
        assert se.wait_for(lambda m: m.get("event") == "progress"
                           and m.get("data", {}).get("total")), "probe 无响应"
        se.send(cmd="run")
        assert se.wait_for(lambda m: m.get("event") == "done"), "第一次没有 done"
        f = Path(dest)
        before = md5(f)
        size_before = f.stat().st_size
        assert before == EXPECT_MD5, "首下成品 md5 就不对，测试前置失效"
        # 清掉已有事件，再发一条 run：应幂等回 done，且不触碰成品、不重建 .part。
        with se.lock:
            se.ev.clear()
        se.send(cmd="run")
        assert se.wait_for(lambda m: m.get("event") == "done", timeout=20), "重复 run 没回 done"
        assert md5(f) == before, "已 done 后重复 run 覆盖了成品"
        assert f.stat().st_size == size_before == len(DATA), "重复 run 改变了成品大小"
        assert f.read_bytes() != b"\x00" * size_before, "成品被覆盖成全零文件"
        assert not Path(dest + ".part").exists(), "重复 run 不该重建 .part"
        return "已完成后重复 run 幂等"
    finally:
        se.close()
        s.shutdown()


# (e) 缺陷 5：.part 被外部删掉时不得盲信边车偏移，需清零从头下，避免成品留空洞。
def test_part_deleted_restarts_clean():
    s = serve(RangeHandler, PORT)
    cleanup("pdel")
    dest = str(TMP / "pdel" / "out.bin")
    url = f"http://127.0.0.1:{PORT}/f.bin"
    seg = len(DATA) // 4
    wipe(dest)                                 # 确保 .part 与成品都是干净缺失状态
    # 边车谎报段0已下 seg 字节，但 .part 文件被删（磁盘上不存在）。
    _write_meta(dest, url, 4, {0: seg, 1: 0, 2: 0, 3: 0})
    part = Path(dest + ".part")
    if part.exists():
        part.unlink()
    se = Session()
    try:
        se.send(cmd="probe", url=url, dest=dest, threads=4, proxy="", user_agent="")
        assert se.wait_for(lambda m: m.get("event") == "progress"
                           and m.get("data", {}).get("total")), "probe 无响应"
        se.send(cmd="run")
        assert se.wait_for(lambda m: m.get("event") == "done", timeout=60), "没有 done 事件"
        # 若信边车：段0 被跳过、[0,seg) 留全零空洞 → md5 不匹配。
        assert md5(Path(dest)) == EXPECT_MD5, ".part 被删却仍信边车 → 成品有空洞"
        return ".part 被删后不盲信边车"
    finally:
        se.close()
        s.shutdown()


# (f) 缺陷 6：stdin 收到非法 UTF-8 字节不得让引擎静默 exit 0，进程须存活并能续处理。
def test_stdin_invalid_utf8_survives():
    s = serve(RangeHandler, PORT)
    cleanup("badutf")
    dest = str(TMP / "badutf" / "out.bin")
    wipe(dest)
    se = Session()
    try:
        se.send(cmd="probe", url=f"http://127.0.0.1:{PORT}/f.bin",
                dest=dest, threads=8, proxy="", user_agent="")
        assert se.wait_for(lambda m: m.get("event") == "progress"
                           and m.get("data", {}).get("total")), "probe 无响应"
        # 灌一行非 UTF-8 字节：旧实现 read_line 报错→当成 EOF→进程安静退出。
        se.send_raw(b"\xff\xfe\x00 this is not json\n")
        # 非法字节被替换成 U+FFFD → serde_json 报 bad json，但进程必须还活着。
        assert se.wait_for(lambda m: m.get("event") == "error"
                           and "bad json" in str(m.get("error", "")),
                           timeout=20), "非 UTF-8 行没回 bad json（可能已静默退出）"
        assert se.p.poll() is None, "收到非法 UTF-8 后引擎进程退出了"
        # 之后仍能正常处理下一条命令并完整下载。
        se.send(cmd="run")
        assert se.wait_for(lambda m: m.get("event") == "done", timeout=60), "坏字节后无法继续下载"
        assert md5(Path(dest)) == EXPECT_MD5, "坏字节后下载内容不对"
        return "非法 UTF-8 不导致静默退出"
    finally:
        se.close()
        s.shutdown()


# (g) 缺陷 7：服务器声称 Accept-Ranges 却无视 Range → 必须退回单线程正常下完，
#     而不是切成多段后每段都触发「归零重下」死循环、最后报「下载失败」。
def test_pseudo_range_falls_back_to_single():
    s = serve(PseudoRangeHandler, PORT_PSEUDO)
    dest = str(TMP / "pseudorg" / "out.bin")
    url = f"http://127.0.0.1:{PORT_PSEUDO}/f.bin"
    wipe(dest)
    se = Session()
    try:
        se.send(cmd="probe", url=url, dest=dest, threads=8, proxy="", user_agent="")
        assert se.wait_for(lambda m: m.get("event") == "progress"
                           and m.get("data", {}).get("total")), "probe 无响应"
        snap = se.last_progress()
        assert snap.get("threads") == 1, (
            f"只认 Accept-Ranges 就切成 {snap.get('threads')} 段；"
            "该服务器从不回 206，多段必然全部失败")
        se.send(cmd="run")
        assert se.wait_for(lambda m: m.get("event") == "done", timeout=60), "没有 done 事件"
        assert md5(Path(dest)) == EXPECT_MD5, "伪 Range 服务器下出来的文件 md5 不匹配"
        return "伪 Range 服务器退单线程下完"
    finally:
        se.close()
        s.shutdown()


# (h) 坏服务器（带 Range 的请求一律 416）必须给出可读 error，且不产出成品/不静默残缺。
def test_416_reports_clean_error():
    s = serve(Always416Handler, PORT_416)
    dest = str(TMP / "gone416" / "out.bin")
    url = f"http://127.0.0.1:{PORT_416}/f.bin"
    wipe(dest)
    se = Session()
    try:
        se.send(cmd="probe", url=url, dest=dest, threads=4, proxy="", user_agent="")
        assert se.wait_for(lambda m: m.get("event") == "progress"
                           and m.get("data", {}).get("total")), "probe 无响应"
        se.send(cmd="run")
        assert se.wait_for(lambda m: m.get("event") == "error", timeout=60), "416 没有上报 error"
        with se.lock:
            errs = [m for m in se.ev if m.get("event") == "error"]
            assert not any(m.get("event") == "done" for m in se.ev), "416 却发了 done"
        assert "416" in str(errs[-1].get("error", "")), (
            f"error 文案没带上服务器状态码，用户无法判断：{errs[-1]}")
        assert not Path(dest).exists(), "416 失败的半截 .part 被 rename 成了成品"
        return "416 服务器干净失败"
    finally:
        se.close()
        s.shutdown()


# (i) 限速：实测墙钟时间必须 ≥ 设定值算出的理论下限，且一个任务内所有分段共享同一个桶。
def _probe_rate_session(url: str, dest: str, threads: int, kbps: int) -> Session:
    """起一个已 probe 好、带限速的新引擎会话（新进程，避免上一轮的 done 串味）。"""
    wipe(dest)
    se = Session()
    se.send(cmd="probe", url=url, dest=dest, threads=threads, proxy="", user_agent="",
            rate_limit_kbps=kbps, checksum="")
    assert se.wait_for(lambda m: m.get("event") == "progress"
                       and m.get("data", {}).get("total")), "probe 无响应"
    return se


def test_rate_limit_caps_throughput():
    handler = type("RateRange", (RangeBodyHandler,), {"body": RATE_BODY})
    s = serve(handler, PORT_RATE)
    dest = str(TMP / "rate" / "out.bin")
    url = f"http://127.0.0.1:{PORT_RATE}/f.bin"

    # ---- A) 全程限速跑完：耗时用真实墙钟测量，和设定值推出的下限比 ----
    # 为什么这里必须真分成 4 段：如果只有 1 段，「每段各限一份」和「整任务共享一桶」
    # 是同一件事，时间达标也证明不了 aria2 语义。所以先把分段数断言死。
    se = _probe_rate_session(url, dest, 4, RATE_KBPS)
    try:
        snap = se.last_progress()
        assert snap.get("rate_limit_kbps") == RATE_KBPS, (
            f"probe 快照没回显限速（settings.json 里那份要靠它核对）：{snap}")
        assert snap.get("threads") == 4, (
            f"限速用例的前提是 4 条分段并发，实际只有 {snap.get('threads')} 段，"
            "改大正文长度或降低 MIN_SEGMENT，否则这条断言是空的")
        t0 = time.time()
        se.send(cmd="run")
        # 下限来自设定值本身，不是机器速度：1032 KiB @ 256 KiB/s ≈ 4.0s，1 秒不可能完。
        time.sleep(1.0)
        with se.lock:
            assert not any(m.get("event") == "done" for m in se.ev), (
                f"{RATE_KBPS} KiB/s 限住 {len(RATE_BODY)} 字节需要 {RATE_FLOOR:.1f}s，"
                "1 秒就完说明限速是空操作")
        mid = se.last_progress()
        ceiling = RATE_KBPS * 1024 * 2  # 留 2 倍余量给 EMA 平滑与令牌桶突发
        assert 0 < mid.get("speed", 0) <= ceiling, (
            f"快照速度 {mid.get('speed')} B/s 不在 {RATE_KBPS} KiB/s 附近，限速没作用到写盘节拍")
        # 引擎自报的速度要拿自报的字节数复核一遍：1 秒顶多约 1.5 个限速周期的量。
        assert mid.get("downloaded", 0) <= 1.5 * RATE_KBPS * 1024, (
            f"1 秒内已写 {mid.get('downloaded')} 字节，超过 {RATE_KBPS} KiB/s 的配额")
        # 至少有一条中间快照里 ≥2 段同时有进度：分段确实是并发跑的，共用同一个桶。
        assert se.wait_for(lambda m: m.get("event") == "progress" and sum(
            1 for g in m.get("data", {}).get("segments", []) if g.get("progress", 0) > 0) >= 2,
            timeout=20), "全程没有出现「≥2 条分段同时在推进」，并发分段这条路径没跑到"
        assert se.wait_for(lambda m: m.get("event") == "done", timeout=60), "限速下载没有 done"
        throttled = time.time() - t0
        # 理论下限 = 总量 / 限速；桶只允许约 100ms 的突发，所以实际只会更慢。
        # 若是「每段各限一份」，4 段并行约 1.0s 就能完，这里会当场失败。
        assert throttled >= RATE_FLOOR * 0.95, (
            f"{RATE_KBPS} KiB/s 限 {len(RATE_BODY)} 字节实测只用了 {throttled:.2f}s，"
            f"低于理论下限 {RATE_FLOOR:.2f}s：限速形同虚设（或每段各限了一份）")
        assert md5(Path(dest)) == RATE_MD5, "限速路径下出来的文件损坏"
    finally:
        se.close()

    # ---- B) 中途改限速：解除后立刻收尾，用来对照 A 的几秒是限速来的而不是服务器慢 ----
    se = _probe_rate_session(url, dest, 4, RATE_KBPS)
    try:
        se.send(cmd="run")
        time.sleep(1.0)
        with se.lock:
            assert not any(m.get("event") == "done" for m in se.ev), "1 秒就完，限速没生效"
        # 清掉已有事件：下面的 done / error 断言只该看到 set_rate 之后发生的事。
        with se.lock:
            se.ev.clear()
        t0 = time.time()
        se.send(cmd="set_rate", rate_limit_kbps=0)
        assert se.wait_for(lambda m: m.get("event") == "done", timeout=20), "解除限速后没有 done"
        unthrottled = time.time() - t0
        assert unthrottled < RATE_FLOOR / 2, (
            f"解除限速后剩余部分还要 {unthrottled:.2f}s：A) 里的 {RATE_FLOOR:.1f}s "
            "就不是限速造成的，时间断言失去意义（或 set_rate 没立刻生效）")
        assert md5(Path(dest)) == RATE_MD5, "改限速后文件损坏"
        assert se.last_progress().get("rate_limit_kbps") == 0, "set_rate 后快照没回显新限速"
        with se.lock:
            assert not any(m.get("event") == "error" for m in se.ev), "改限速导致下载报错"
        return "限速实测 + 运行中改限速"
    finally:
        s.shutdown()


# (j) 未知长度（chunked、HEAD 问不出 Content-Length）
def test_unknown_length_single_stream():
    RANGE_SEEN.clear()
    s = serve(ChunkedHandler, PORT_CHUNKED)
    dest = str(TMP / "chunked" / "out.bin")
    url = f"http://127.0.0.1:{PORT_CHUNKED}/stream"
    se = Session()
    try:
        wipe(dest)
        se.send(cmd="probe", url=url, dest=dest, threads=8, proxy="", user_agent="")
        # 只能等 `state == "idle"` 那条完整快照：probe 的第一条应答是
        # `{"state":"preparing"}`，里面没有 total，拿它判「total 是不是 0」必然误判。
        assert se.wait_for(lambda m: m.get("event") == "progress"
                           and m.get("data", {}).get("state") == "idle",
                           timeout=20), "未知长度服务器无响应"
        snap = se.last_progress()
        assert not snap.get("error"), f"未知长度被当成探测失败：{snap.get('error')}"
        assert snap.get("total") == 0, "问不出长度却凭空报了个 total"
        assert snap.get("threads") == 1 and len(snap.get("segments", [])) == 1, (
            f"未知长度必须单流，实际 {snap.get('threads')} 段")
        assert snap.get("rate_limit_kbps") == 0 and snap.get("verifying") is False, (
            f"完整快照的新字段默认值不对：{snap}")
        se.send(cmd="run")
        assert se.wait_for(lambda m: m.get("event") == "done", timeout=60), "未知长度没有 done"
        final = se.last_progress()
        assert final.get("total") == len(CHUNK_BODY), (
            f"done 时 total 没回填成真实字节数：{final.get('total')}")
        assert md5(Path(dest)) == CHUNK_MD5, "chunked 分块重组损坏"
        assert not Path(dest + ".part").exists(), ".part 没被 rename 成成品"
        assert not Path(dest + ".part.meta").exists(), "未知长度不该留下边车"
        with se.lock:
            ev = list(se.ev)
            assert not any(m.get("event") == "error" for m in ev), "未知长度下载不该报错"
        dones = [i for i, m in enumerate(ev) if m.get("event") == "done"]
        assert dones[0] == len(ev) - 1, "done 不是最后一条事件（终态快照必须先于 done）"
        assert ev[dones[0]].get("total") == len(CHUNK_BODY), (
            f"done 事件自带的 total 不是真实字节数：{ev[dones[0]]}")
        # 全程逐条快照复核：threads 恒为 1（坑 7：回退后不许停在 8），
        # 且 total 还是 0 的那些快照里 progress / eta 必须都是 0——
        # 没有总长就不能瞎报百分比，否则界面会一直显示 0% 或算出荒谬 ETA。
        prog = [m["data"] for m in ev if m.get("event") == "progress" and "threads" in m["data"]]
        assert len(prog) > 1, f"中途没有推进快照，看不出「全程单流」（只有 {len(prog)} 条）"
        assert all(p["threads"] == 1 for p in prog), (
            f"未知长度中途出现过 {sorted({p['threads'] for p in prog})} 条分段")
        zero = [p for p in prog if p["total"] == 0]
        assert zero and all(p["progress"] == 0 and p["eta"] == 0 for p in zero), (
            "total 未知时 progress/eta 必须恒为 0")
        assert max(p["downloaded"] for p in zero) > 0, (
            "total 未知的快照里 downloaded 一直是 0：字节到底有没有落盘？")
        assert all(not p["verifying"] for p in prog), "没给校验和却报 verifying"
        assert not RANGE_SEEN, f"未知长度全程不该发 Range，实际发了：{RANGE_SEEN}"

        # 长度未知**不支持断点续传**：`.part` 里那段前缀没法证明和这次内容是同一份
        # （服务器可能换了文件，也可能上一轮只写了半截），所以必须从 0 重下。
        # 这里先摆一个 5000 字节的假前缀 + 一个谎报偏移的边车：
        # 若引擎信了边车从 5000 接着写，成品前 5000 字节就是错的 → md5 立刻暴露。
        RANGE_SEEN.clear()
        wipe(dest)
        p = Path(dest)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.with_suffix(p.suffix + ".part").write_bytes(b"\xa5" * 5_000)
        p.with_suffix(p.suffix + ".part.meta").write_text(json.dumps({
            "url": url, "total": len(CHUNK_BODY), "threads": 1, "segments": {"0": 5_000},
        }), encoding="utf-8")
        with se.lock:
            se.ev.clear()
        se.send(cmd="probe", url=url, dest=dest, threads=8, proxy="", user_agent="")
        assert se.wait_for(lambda m: m.get("event") == "progress"
                           and m.get("data", {}).get("state") == "idle"
                           and m.get("data", {}).get("downloaded") == 0,
                           timeout=20), "未知长度不该把假前缀当续传进度"
        assert se.last_progress().get("threads") == 1, "重探测后又按 8 段布局了"
        se.send(cmd="run")
        assert se.wait_for(lambda m: m.get("event") == "done", timeout=60), "带假 .part 时没有 done"
        assert md5(Path(dest)) == CHUNK_MD5, "未知长度信了残留 .part/边车 → 成品前缀是错的"
        assert not Path(dest + ".part").exists(), "rename 后 .part 还在"
        assert not RANGE_SEEN, f"第二条未知长度下载发了 Range：{RANGE_SEEN}"
        return "未知长度（chunked）单流下完"
    finally:
        se.close()
        s.shutdown()


# (k) 校验和：通过才 rename；不通过保留 .part；非法值可读报错且不启动下载。
def _checksum_run(url: str, dest: str, checksum: str, threads: int = 8) -> dict:
    """起一个**独立**引擎进程跑一条带校验和的下载，返回结构化结果。

    每个子用例换新会话的原因：done / error 是事件流里的历史。同一个进程里连着跑
    两条，上一条的 done 会让下一条的 `wait_for(done)` 立刻误判通过——校验不通过
    却「看着像成功」。换新进程没有这种串味。
    """
    wipe(dest)
    for suf in (".part", ".part.meta"):
        try:
            Path(dest + suf).unlink()
        except OSError:
            pass
    se = Session()
    out = {"probe_ok": False, "done": False, "error": "", "verifying_seen": False,
           "terminal_is_snapshot": False, "probe_snap": {}, "final_snap": {}}
    try:
        se.send(cmd="probe", url=url, dest=dest, threads=threads, proxy="",
                user_agent="", checksum=checksum)
        if not se.wait_for(lambda m: m.get("event") in ("progress", "error"), timeout=20):
            out["error"] = "<probe 无任何响应>"
            return out
        with se.lock:
            errs = [str(m.get("error", "")) for m in se.ev if m.get("event") == "error"]
        if errs:
            # 非法校验和应当在 probe 阶段就被拒掉，根本不进入下载
            out["error"] = errs[-1]
            return out
        out["probe_ok"] = True
        out["probe_snap"] = se.last_progress()
        se.send(cmd="run")
        se.wait_for(lambda m: m.get("event") in ("done", "error"), timeout=60)
        with se.lock:
            ev = list(se.ev)
        out["done"] = any(m.get("event") == "done" for m in ev)
        errs = [str(m.get("error", "")) for m in ev if m.get("event") == "error"]
        out["error"] = errs[-1] if errs else ""
        out["verifying_seen"] = any(m.get("event") == "progress"
                                    and m.get("data", {}).get("verifying") for m in ev)
        # 坑 5：终态必须先落一条 progress 快照，再发 done/error。
        # 主进程是先写盘后退出的写法，终态少了那条快照就会掉进度（重启后任务回到半截）。
        term = [i for i, m in enumerate(ev) if m.get("event") in ("done", "error")]
        out["terminal_is_snapshot"] = bool(term) and ev[term[0] - 1].get("event") == "progress"
        prog = [m for m in ev if m.get("event") == "progress"]
        out["final_snap"] = prog[-1]["data"] if prog else {}
        return out
    finally:
        se.close()


def test_checksum_verify():
    s = serve(RangeHandler, PORT)
    url = f"http://127.0.0.1:{PORT}/f.bin"
    base = TMP / "cksum"
    base.mkdir(parents=True, exist_ok=True)
    try:
        # 1) sha256 前缀 + 正确值 → 校验通过才 rename，且校验过程对界面可见
        r = _checksum_run(url, str(base / "good.bin"), f"sha256:{EXPECT_SHA256}")
        assert r["probe_ok"], f"合法 sha256 被拒：{r['error']}"
        assert r["verifying_seen"], (
            "字节下完后没有 verifying 快照：校验对界面不可见，用户会以为卡死")
        assert r["done"], f"校验通过却没发 done：{r['error']}"
        assert md5(base / "good.bin") == EXPECT_MD5, "sha256 校验通过但文件内容不对"
        assert r["final_snap"].get("verifying") is False, "done 之后 verifying 没落下"
        assert r["final_snap"].get("state") == "done", f"终态快照 state={r['final_snap'].get('state')}"

        # 2) 裸 64 位十六进制按长度推断为 sha256；裸 32 位必须要求补前缀。
        #    md5/sha1 的长度歧义太大，猜错等于校验个寂寞。UI 侧 normalizeChecksum
        #    会把裸 md5 补成 `md5:` 前缀再下发，正是为了对上这条规则。
        r = _checksum_run(url, str(base / "bare.bin"), EXPECT_SHA256)
        assert r["done"], f"裸 sha256 没被接受：{r['error']}"
        assert md5(base / "bare.bin") == EXPECT_MD5, "裸 sha256 用例文件损坏"
        r = _checksum_run(url, str(base / "baremd5.bin"), EXPECT_MD5, threads=4)
        assert not r["probe_ok"] and "prefix" in r["error"], (
            f"裸 32 位 md5 应被要求补前缀而不是被猜成别的算法：{r['error']!r}")
        assert not Path(str(base / "baremd5.bin")).exists(), "被拒的校验和却照常下载了"

        # 3) 值不匹配 → error，且**保留 .part 原样**（不删、不截断）、不产出成品
        r = _checksum_run(url, str(base / "bad.bin"), "sha256:" + "0" * 64)
        assert not r["done"], "校验不通过却发了 done"
        assert "checksum mismatch" in r["error"], (
            f"error 文案不含 checksum mismatch，errors.ts 翻译不到它：{r['error']!r}")
        assert "expected sha256:" in r["error"] and "got sha256:" in r["error"], (
            f"error 文案没同时给出期望值和实际值，用户无从判断是下错还是给错：{r['error']!r}")
        assert not Path(str(base / "bad.bin")).exists(), "校验失败的残缺文件被 rename 成了成品"
        kept = Path(str(base / "bad.bin") + ".part")
        assert kept.exists(), (
            "校验不通过就删文件：用户得白下几十 GB，必须保留 .part 让他自己决定")
        # 保留就得是「完整的、能用的」：既没被截断也没被动过。长度等于 total，
        # 且逐字节 md5 就是真实内容——校验失败不该影响已落盘的数据本身。
        assert kept.stat().st_size == len(DATA), f"保留的 .part 被截断了：{kept.stat().st_size}"
        assert md5(kept) == EXPECT_MD5, "保留的 .part 内容被改坏，等于没保留"
        assert r["terminal_is_snapshot"], "终态快照没排在 error 之前（主进程会丢掉终态）"
        assert r["final_snap"].get("state") == "error", f"终态快照 state={r['final_snap'].get('state')}"
        assert r["final_snap"].get("verifying") is False, "失败终态里 verifying 还挂着"
        assert r["final_snap"].get("total") == len(DATA), "校验失败不该改动 total"

        # 4) md5 / sha1 前缀各自走自己的分发分支：这里要的是「算法选对了」这件事，
        #    而不是哈希库对不对（那由 Rust 单元测试的已知向量兜）。
        #    少跑一条就可能把 `Alg::Md5 => sha1` 这种张冠李戴留到用户机器上。
        r = _checksum_run(url, str(base / "md5.bin"), f"md5:{EXPECT_MD5}", threads=4)
        assert r["done"], f"正确的 md5 被判失败：{r['error']}"
        r = _checksum_run(url, str(base / "sha1.bin"), f"sha1:{EXPECT_SHA1}", threads=4)
        assert r["done"], f"正确的 sha1 被判失败：{r['error']}"
        assert md5(base / "sha1.bin") == EXPECT_MD5, "sha1 用例文件损坏"
        # 拿 md5 的值冒充 sha1：长度合法但内容对不上，必须失败（说明真算了 sha1）
        r = _checksum_run(url, str(base / "cross.bin"), f"sha1:{'0' * 40}", threads=4)
        assert not r["done"] and "expected sha1:" in r["error"], (
            f"sha1 用假值却没报错，说明这条分支根本没校验：{r['error']!r}")

        # 5) 不支持的算法 → 可读 error，不进入下载
        r = _checksum_run(url, str(base / "crc.bin"), "crc32:deadbeef", threads=4)
        assert not r["probe_ok"] and "crc32" in r["error"], (
            f"crc32 这种不支持的算法没被明确拒绝：{r['error']!r}")
        assert not Path(str(base / "crc.bin")).exists(), "非法校验和却照常下载了"
        return "校验和：通过/裸值/不匹配/非法算法"
    finally:
        s.shutdown()


def main():
    TMP.mkdir(exist_ok=True)
    if not EXE.exists():
        print(f"FAIL 引擎不存在: {EXE}")
        return 1
    print(f"数据 {len(DATA)} 字节, md5 {EXPECT_MD5}")
    cases = [
        ("分段并发下载", test_ranges),
        ("不支持 Range 单线程回退", test_no_ranges),
        ("断点续传", test_resume),
        ("错误上报", test_bad_url),
        ("无视 Range + from>0 续传不损坏", test_no_range_resume_from_offset),
        ("Content-Range 区间不符被拒绝", test_content_range_mismatch_rejected),
        ("中途改线程数不虚高进度", test_set_threads_midflight),
        ("已完成后重复 run 幂等", test_run_after_done_idempotent),
        (".part 被删后不盲信边车", test_part_deleted_restarts_clean),
        ("非法 UTF-8 不导致静默退出", test_stdin_invalid_utf8_survives),
        ("伪 Range 服务器退单线程下完", test_pseudo_range_falls_back_to_single),
        ("416 服务器干净失败", test_416_reports_clean_error),
        ("限速实测 + 运行中改限速", test_rate_limit_caps_throughput),
        ("未知长度（chunked）单流下完", test_unknown_length_single_stream),
        ("校验和通过/不匹配/非法", test_checksum_verify),
    ]
    failed = 0
    for name, fn in cases:
        t0 = time.time()
        try:
            fn()
            print(f"  PASS  {name:<26} ({time.time() - t0:.2f}s)")
        except AssertionError as e:
            failed += 1
            print(f"  FAIL  {name:<26} {e}")
        except Exception as e:
            failed += 1
            print(f"  FAIL  {name:<26} {type(e).__name__}: {e}")
    print("ALL PASS" if not failed else f"{failed} FAILED")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
