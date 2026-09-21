"""代理链路离线端到端测试：假源站 + 假代理 + 真引擎 + 真 Electron 抓取层。

验的是 2026-09 这一轮改动最要紧的一条不变量：**一份代理设置必须同时下发到
三条网络栈**（站点抓取层 / 内嵌浏览器 / Rust 引擎），且没生效时必须报可读原因，
而不是静默直连——静默直连的用户表现是「代理软件明明开着，下载还是 403」。

覆盖：
1. 引擎：不配代理 → 源站 403（证明代理确实是通路的一部分，而不是摆设）
2. 引擎：配 http 代理 → 下载完成、md5 正确、且代理真的被走过（命中计数 > 0）
3. 引擎：非法代理串 → 明确报 invalid proxy url（以前是 `if let Ok(..)` 静默直连）
4. 引擎：socks5:// 串 → 被接受（reqwest 的 socks 特性若没开，这里会报非法）
5. Electron 抓取层：同一份 applyChromiumProxy 让 403 变 200
6. Electron：`resolveProxy` 的返回串形状 → 引擎可用 URL（以前全靠猜）
7. Electron：裸 host:port 归一化、非法串当场拒绝
8. Electron + 引擎任务：上一轮代理失败后只改设置里的代理再点「继续下载」，必须真的换出口
   下完（引擎的 client 建在 probe 时，失败后子进程不退出，复用旧进程就还是上一轮那个错）
9. Electron + 假网盘（120 分卷、其中一个换直链故意失败）：截断数与失败数必须真的
   进到「共 N 个文件（还有 M 个未加入）」这句播报与 missing 计数里——60 分卷只下
   一半却不告知，等于不可见的丢件
10. Electron：站点列表页的 href 绝对/相对/协议相对都要认（只认绝对写法时，改版解析出
    0 条会被报成「站点改版」，那是我们的假设错了）；内嵌浏览器捕获的下载要认得站点的
    全部域名（含 gamers520.com 这个少一个 r 的镜像域）
11. Electron：界面白屏时的自救出口（main/uiRescue.ts）——真开一扇窗口去加载不存在的
    产物，要求屏幕上换成写清原因的兜底页、给出四个出口、点「重新加载界面」真的一次导航；
    并要求看门狗**不拦已报就绪的界面**（判据写反比白屏更难解释）；窗口销毁重建后
    （关窗再从托盘重开是常规路径）下一轮白屏仍要能出兜底页，否则自救只够用一次

全部只连本机，不访问任何真实站点。源站故意绑到**局域网 IP**而不是 127.0.0.1：
Chromium 默认对回环地址不发代理，用 127.0.0.1 当目标会让第 5 步永远测不出代理。

跑法（先 `cd engine-rs && cargo build --release`）：
    py tests/test_proxy_e2e.py
"""
from __future__ import annotations

import hashlib
import http.server
import json
import os
import shutil
import socket
import socketserver
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

# Windows runner（英文区域）默认 stdout 是 cp1252，中文输出 print 即崩；
# 强制 utf-8，与 test_engine_rs 保持一致。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_engine_rs import Session, md5  # noqa: E402  复用同一套引擎驱动

ROOT = Path(__file__).resolve().parents[1]
TMP = ROOT / "tests" / "_tmp_proxy"
ENTRY = ROOT / "tests" / "proxy_e2e_entry.ts"
ELECTRON = ROOT / "app" / "node_modules" / "electron" / "dist" / (
    "electron.exe" if sys.platform == "win32" else "electron")


def esbuild_cmd() -> list[str] | None:
    """仓库自带的 esbuild 调用方式。

    `node_modules/esbuild/bin/esbuild` 在 Windows 上是个 Node 脚本而不是 exe，
    真正能直接 spawn 的是平台包里的 `@esbuild/<plat>/esbuild(.exe)`；
    找不到平台包时退回 `node 那个脚本`，两条路都比「假设 bin 是 exe」可靠。
    """
    pkg = ROOT / "app" / "node_modules" / "@esbuild"
    pattern = "esbuild.exe" if os.name == "nt" else "esbuild"
    native = sorted(pkg.glob(f"*/{pattern}"))
    if native:
        return [str(native[0])]
    node = shutil.which("node")
    shim = ROOT / "app" / "node_modules" / "esbuild" / "bin" / "esbuild"
    if node and shim.exists():
        return [node, str(shim)]
    return None

PORT_ORIGIN = 18901
PORT_PROXY = 18902
# 第二个代理：只放行探测（HEAD / bytes=0-0），正式下载一律 403。
# 有了它才能造出「probe 成功、run 失败」这一种失败——恰恰是复用旧子进程时
# 唯一会出问题的那种（probed 已经是 true，第二轮只发 run，改不动引擎里那个 client）。
PORT_PROXY_PROBE_ONLY = 18903
# 假 NekoGAL 网盘（见 FakeCloudreveHandler）
PORT_FAKE_CR = 18904
CR_BASE_URL = f"http://127.0.0.1:{PORT_FAKE_CR}"

SHARE_NAME = "FD 假分享 全集"
# 120 个分卷：超过解析器的单次上限（CR_MAX_FILES=60），截断才会真的发生
SHARE_FILE_COUNT = 120
# 故意排在截断范围内（part001..part060）的一个，让「换直链失败」也被计入播报
BAD_SHARE_FILE = "vol1.part004.rar"
FAKE_SHARE_FILES = [
    {
        "type": 0,
        "name": f"vol1.part{i:03d}.rar",
        "path": f"/s/fdtest/vol1.part{i:03d}.rar",
        "size": 1024,
    }
    for i in range(1, SHARE_FILE_COUNT + 1)
]

BODY = bytes((((i * 2246822519) >> 21) ^ (i >> 5) ^ (i * 7)) & 0xFF for i in range(1_048_660))  # 1 MiB + 84
BODY_MD5 = hashlib.md5(BODY).hexdigest()
# 抓取层那几步要逐字节比对正文，用一小段定长文本比拿 1 MiB 二进制好读得多。
TEXT = b"FAKE-FILE-CONTENT"
PROXY_TOKEN = "fastdrop-e2e"
PROXY_TOKEN_PROBE_ONLY = "fastdrop-e2e-probe-only"

# 代理转发时注入这个头，源站只认它。于是「通不通」直接等价于「有没有走代理」。
proxy_hits = 0
proxy_lock = threading.Lock()


def lan_ip() -> str:
    """本机对外的局域网 IP（UDP connect 不发包，纯本地调用，不需要联网）。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


class OriginHandler(http.server.BaseHTTPRequestHandler):
    """只有经代理注入令牌的请求才放行，其余一律 403。支持 Range 以便分段。"""

    protocol_version = "HTTP/1.1"

    def _decide(self) -> None:
        tok = self.headers.get("X-Via-Proxy")
        if tok == PROXY_TOKEN_PROBE_ONLY:
            # 「只放行探测」那台代理：探测是 HEAD 或 bytes=0-0，正式下载是带真实区间的
            # GET。放行前者、拒掉后者，就能稳定造出「probe 过了、run 才失败」。
            rng = self.headers.get("Range")
            if not (self.command == "HEAD" or rng == "bytes=0-0"):
                self.send_response(403)
                self.send_header("content-length", "0")
                self.end_headers()
                return
        elif tok != PROXY_TOKEN:
            self.send_response(403)
            self.send_header("content-length", "0")
            self.end_headers()
            return
        # /f.bin 给引擎跑分段与 md5；其余路径给抓取层跑逐字节正文比对。
        payload = BODY if self.path.startswith("/f.bin") else TEXT
        rng = self.headers.get("Range") if payload is BODY else None
        if rng and rng.startswith("bytes="):
            first, _, last = rng[6:].partition("-")
            f = int(first or 0)
            t = int(last) if last else len(BODY) - 1
            t = min(t, len(BODY) - 1)
            chunk = BODY[f:t + 1]
            self.send_response(206)
            self.send_header("content-length", str(len(chunk)))
            self.send_header("content-range", f"bytes {f}-{t}/{len(BODY)}")
            self.send_header("accept-ranges", "bytes")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(chunk)
            return
        self.send_response(200)
        self.send_header("content-length", str(len(payload)))
        self.send_header("accept-ranges", "bytes")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    do_GET = _decide
    do_HEAD = _decide

    def log_message(self, *_a) -> None:  # 静音
        pass


class ProxyHandler(http.server.BaseHTTPRequestHandler):
    """最简 HTTP 转发代理：请求行是绝对地址，转发时补上源站令牌。"""

    protocol_version = "HTTP/1.1"
    token = PROXY_TOKEN

    def _forward(self) -> None:
        global proxy_hits
        url = self.path
        if not url.startswith("http://"):
            self.send_response(400)
            self.send_header("content-length", "0")
            self.end_headers()
            return
        with proxy_lock:
            proxy_hits += 1
        req = urllib.request.Request(url, method=self.command)
        # Range 必须原样带过去：吞掉它源站就会回 200 整份，引擎的错位保护会判
        # 「服务器无视 Range」，测出来的是代理的错而不是代码的错。
        skip = {"host", "connection", "proxy-connection", "content-length", "accept-encoding",
                "x-via-proxy"}
        for k, v in self.headers.items():
            if k.lower() not in skip:
                req.add_header(k, v)
        req.add_header("X-Via-Proxy", self.token)
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                payload = r.read() if self.command != "HEAD" else b""
                status, headers = r.status, list(r.headers.items())
        except urllib.error.HTTPError as e:
            payload = b"" if self.command == "HEAD" else e.read()
            status, headers = e.code, list(e.headers.items())
        except OSError:
            self.send_response(502)
            self.send_header("content-length", "0")
            self.end_headers()
            return
        self.send_response(status)
        skip = {"transfer-encoding", "connection", "keep-alive", "content-length"}
        for k, v in headers:
            if k.lower() not in skip:
                self.send_header(k, v)
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        if payload:
            self.wfile.write(payload)

    do_GET = _forward
    do_HEAD = _forward


class ProbeOnlyProxyHandler(ProxyHandler):
    """注入「只放行探测」令牌的代理：源站会拒掉真正的下载请求。"""

    token = PROXY_TOKEN_PROBE_ONLY

    def log_message(self, *_a) -> None:
        pass


class FakeCloudreveHandler(http.server.BaseHTTPRequestHandler):
    """假 NekoGAL 网盘：120 个分卷，其中第 4 个换直链故意失败。

    为什么要自己造一个：CR_MAX_FILES 的截断、以及「取直链失败」的计数，只有在
    文件数超过上限的分享上才会触发。真实分享站既有那么多分卷、又要我们连得上、
    还允许反复打——拿它当测试对象等于没有测试。

    绑回环地址是有意的：Chromium 对回环目标不发代理，前面几步设过的代理不会
    把这一路的请求拐去假代理，测出来的才是解析器本身的行为。
    """

    protocol_version = "HTTP/1.1"

    def _json(self, obj: dict) -> None:
        payload = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        if self.path.startswith("/api/v4/share/info/"):
            self._json({"code": 0, "data": {"name": SHARE_NAME}})
            return
        if self.path.startswith("/api/v4/file?"):
            self._json({"code": 0, "data": {"files": FAKE_SHARE_FILES}})
            return
        self.send_response(404)
        self.send_header("content-length", "0")
        self.end_headers()

    def do_POST(self) -> None:
        n = int(self.headers.get("content-length") or 0)
        try:
            body = json.loads(self.rfile.read(n).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            body = {}
        uris = body.get("uris") or []
        path = uris[0] if uris else ""
        if path.endswith(BAD_SHARE_FILE):
            # 真实网盘在换直链这一步翻脸时给的是 code!=0 + HTTP 200，照抄这个形状
            self._json({"code": 10, "msg": "此文件暂时不可下载"})
            return
        self._json({"code": 0, "data": {"urls": [{"url": f"{CR_BASE_URL}/dl{path}"}]}})

    def log_message(self, *_a) -> None:
        pass


def serve(handler, host: str, port: int) -> http.server.HTTPServer:
    class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
        allow_reuse_address = True
        daemon_threads = True

        def handle_error(self, request, client_address):
            # 客户端（reqwest / urllib）在 keep-alive 空闲时直接关连接是常态，
            # 每次都甩一整页 traceback 会把真正的失败淹掉。其余异常照常抛给默认实现。
            exc = sys.exc_info()[1]
            if isinstance(exc, (ConnectionResetError, ConnectionAbortedError, TimeoutError, BrokenPipeError)):
                return
            super().handle_error(request, client_address)

    srv = Server((host, port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def reset_hits() -> None:
    global proxy_hits
    with proxy_lock:
        proxy_hits = 0


def hits() -> int:
    with proxy_lock:
        return proxy_hits


def engine_download(url: str, dest: str, proxy: str, threads: int = 4) -> tuple[str, dict]:
    """跑一轮 probe+run，返回 (终态, 最后一条进度快照)。终态可能是 done/error/timeout。"""
    TMP.mkdir(parents=True, exist_ok=True)
    for p in (dest, dest + ".part", dest + ".part.meta"):
        try:
            Path(p).unlink()
        except OSError:
            pass
    s = Session()
    try:
        s.send(cmd="probe", url=url, dest=dest, threads=threads,
               proxy=proxy, user_agent="")
        # 只等「探测收尾」那一条：probe 的第一条应答 state 还是 preparing，
        # 且那条里的 total 是上一轮继承的旧值，拿它当准数会看错。
        settled = s.wait_for(lambda m: m.get("event") == "error"
                             or (m.get("event") == "progress"
                                 and m.get("data", {}).get("state") == "idle"), timeout=30)
        with s.lock:
            errs = [m for m in s.ev if m.get("event") == "error"]
        if errs:
            return f"error: {errs[-1].get('error', '')}", {}
        if not settled:
            return "timeout", s.last_progress()
        s.send(cmd="run")
        ok = s.wait_for(lambda m: m.get("event") in ("done", "error"), timeout=60)
        with s.lock:
            ev = list(s.ev)
        errs = [m for m in ev if m.get("event") == "error"]
        if errs:
            return f"error: {errs[-1].get('error', '')}", s.last_progress()
        if not ok:
            return "timeout", s.last_progress()
        return "done", s.last_progress()
    finally:
        s.close()


def test_engine_direct_rejected(origin: str) -> str:
    reset_hits()
    state, _ = engine_download(f"{origin}/f.bin", str(TMP / "direct" / "out.bin"), proxy="", threads=1)
    assert "http 403" in state, f"不配代理应当被源站 403，实际：{state}"
    assert hits() == 0, f"这一步压根不该经过代理，实际命中 {hits()} 次"
    return "引擎不配代理时被 403（代理不是摆设）"


def test_engine_via_proxy(origin: str, proxy_url: str) -> str:
    reset_hits()
    dest = str(TMP / "viaproxy" / "out.bin")
    state, snap = engine_download(f"{origin}/f.bin", dest, proxy=proxy_url)
    assert state == "done", f"配代理后应当下完，实际：{state}"
    assert Path(dest).exists(), "目标文件不存在"
    assert md5(Path(dest)) == BODY_MD5, "md5 不匹配：代理转发路径写坏了字节"
    assert hits() > 0, "代理命中计数为 0：引擎其实没走代理"
    assert snap.get("total") == len(BODY), f"total={snap.get('total')}"
    return "引擎经代理下完且 md5 正确（含分段）"


def test_engine_invalid_proxy(origin: str) -> str:
    reset_hits()
    state, _ = engine_download(f"{origin}/f.bin", str(TMP / "bad" / "out.bin"),
                               proxy="bad proxy string", threads=1)
    assert "invalid proxy url" in state, f"非法代理必须当场报错，实际：{state}"
    return "非法代理串显式报错（不再静默直连）"


def test_engine_socks_accepted(origin: str) -> str:
    """socks5 串不能被当成非法。这里代理端口没人听，所以只要求「不是格式错」。"""
    reset_hits()
    state, _ = engine_download(f"{origin}/f.bin", str(TMP / "socks" / "out.bin"),
                               proxy="socks5://127.0.0.1:1", threads=1)
    assert "invalid proxy url" not in state, f"reqwest 没编进 socks 支持：{state}"
    assert state.startswith("error"), f"socks 端口没人听，本该失败，实际：{state}"
    return "socks5:// 代理串被引擎接受"


def run_electron_checks(origin_host: str) -> tuple[bool, list[dict]]:
    """把 tests/proxy_e2e_entry.ts 打包成 Electron main 并收集断言。

    源站绑的是局域网 IP 而不是 127.0.0.1：Chromium 默认对回环目标不走代理，
    用 127.0.0.1 当目标会让「代理是否真下发到抓取层」这一步永远测不出来。
    """
    esb = esbuild_cmd()
    if not ELECTRON.exists() or not esb:
        return False, [{"name": "electron", "pass": False,
                        "detail": f"缺 electron 或 esbuild：{ELECTRON} / {esb}（先 cd app && npm ci）"}]
    out_dir = TMP / "electron"
    out_dir.mkdir(parents=True, exist_ok=True)
    bundle = out_dir / "main.cjs"
    r = subprocess.run(
        [*esb, str(ENTRY), "--bundle", "--platform=node", "--format=cjs",
         "--external:electron", f"--outfile={bundle}"],
        cwd=str(ROOT), capture_output=True, text=True,
    )
    if r.returncode != 0:
        return False, [{"name": "esbuild", "pass": False, "detail": (r.stderr or r.stdout)[-500:]}]
    (out_dir / "package.json").write_text('{"main":"main.cjs"}', encoding="utf-8")
    env = dict(os.environ)
    env["FD_ORIGIN_BASE"] = f"http://{origin_host}:{PORT_ORIGIN}"
    env["FD_PROXY_PORT"] = str(PORT_PROXY)
    env["FD_PROXY_PORT_PROBE_ONLY"] = str(PORT_PROXY_PROBE_ONLY)
    # engine.ts 找可执行文件的方式是 dirname(FASTDROP_ROOT)/engine-rs/target/...，
    # 而 Electron 的 cwd 是临时打包目录，不显式给就永远定位不到仓库里那个引擎。
    env["FASTDROP_ROOT"] = str(ROOT / "engine-rs")
    env["FD_TMP"] = str(TMP)
    env["FD_BODY_MD5"] = BODY_MD5
    # 假网盘：解析器那两条截断/失败计数只在超大分享上才发生，只能自己造一个
    env["FD_CLOUDREVE_BASE"] = f"{CR_BASE_URL}/api/v4"
    # 隔离 profile：绝不动用户的 ~/.fastdrop 与真实浏览器登录态
    profile = out_dir / "profile"
    p = subprocess.Popen(
        [str(ELECTRON), str(out_dir), f"--user-data-dir={profile}", "--no-sandbox"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        encoding="utf-8", errors="replace", env=env,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    results: list[dict] = []
    try:
        # communicate 而不是逐行读：app.exit 之后 stdout 才关，逐行读要自己管超时。
        out, _ = p.communicate(timeout=180)
    except subprocess.TimeoutExpired:
        p.kill()
        out, _ = p.communicate()
        return False, [{"name": "electron", "pass": False, "detail": "Electron 180 秒没退"}]
    for line in (out or "").splitlines():
        if line.startswith("FD_RESULT "):
            try:
                results.append(json.loads(line[len("FD_RESULT "):]))
            except ValueError:
                pass
    return p.returncode == 0, results


def main() -> int:
    TMP.mkdir(parents=True, exist_ok=True)
    host = lan_ip()
    origin = f"http://{host}:{PORT_ORIGIN}"
    proxy_url = f"http://127.0.0.1:{PORT_PROXY}"
    print(f"源站 {origin}（绑局域网 IP，避开 Chromium 对回环地址的代理豁免）")
    srvs = [serve(OriginHandler, "0.0.0.0", PORT_ORIGIN),
            serve(ProxyHandler, "127.0.0.1", PORT_PROXY),
            serve(ProbeOnlyProxyHandler, "127.0.0.1", PORT_PROXY_PROBE_ONLY),
            serve(FakeCloudreveHandler, "127.0.0.1", PORT_FAKE_CR)]
    fails = 0
    try:
        # 前置：源站本身要活着（经代理拿一次全量，逐字节对 md5）
        cases = [
            ("引擎不配代理被拒", lambda: test_engine_direct_rejected(origin)),
            ("引擎经代理下载", lambda: test_engine_via_proxy(origin, proxy_url)),
            ("引擎非法代理报错", lambda: test_engine_invalid_proxy(origin)),
            ("引擎接受 socks5", lambda: test_engine_socks_accepted(origin)),
        ]
        for label, fn in cases:
            t0 = time.time()
            try:
                note = fn()
                print(f"  PASS  {label:<28} ({time.time() - t0:.2f}s)  {note}")
            except AssertionError as e:
                fails += 1
                print(f"  FAIL  {label:<28} ({time.time() - t0:.2f}s)  {e}")
            except Exception as e:  # noqa: BLE001  用例挂了要报出来而不是整轮崩掉
                fails += 1
                print(f"  ERROR {label:<28} ({time.time() - t0:.2f}s)  {type(e).__name__}: {e}")

        ok, results = run_electron_checks(host)
        for r in results:
            if r["pass"]:
                print(f"  PASS  {r['name']}")
            else:
                print(f"  FAIL  {r['name']}  {r['detail']}")
        fails += sum(1 for r in results if not r["pass"])
        if not results:
            fails += 1
            print("  FAIL  Electron 侧一条断言都没跑出来（见上面 detail）")
        elif not ok:
            print("  （Electron 退出码非 0，以上面逐条结果为准）")
    finally:
        for s in srvs:
            s.shutdown()
    print("ALL PASS" if fails == 0 else f"{fails} FAILED")
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
