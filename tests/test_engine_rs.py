"""Rust 引擎端到端测试：起本地 HTTP 服务，通过 stdio JSON 协议验证。

覆盖：
1. 支持 Range  -> 多段并发下载，校验 md5
2. 不支持 Range -> 单线程回退，校验 md5
3. 断点续传 -> 手写 sidecar 偏移，引擎只补剩余字节
4. 非法 URL -> 返回 error 事件

不联网、不依赖 Qt：`python tests/test_engine_rs.py`
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

ROOT = Path(__file__).resolve().parents[1]
EXE = ROOT / "engine-rs" / "target" / "release" / ("fastdrop-engine.exe" if sys.platform == "win32" else "fastdrop-engine")
TMP = ROOT / "tests" / "_tmp_rs"

DATA = (b"fastdrop-rust-engine\n" * 560_000)   # 12,040,000 字节
EXPECT_MD5 = hashlib.md5(DATA).hexdigest()

PORT = 18873
PORT_NO_RANGE = 18874


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
