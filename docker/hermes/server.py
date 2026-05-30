"""
server.py — Hermes HTTP 包装层

接口:
  GET  /health  → 健康检查
  POST /chat    → body: {"message": "...", "session_id": "...", "source": "..."}
                  返回 {"reply": "...", "session_id": "...", "exit_code": 0}

session_id 用 hermes `--continue <name>` 实现多对话隔离:
  - 不存在 → 新建该 name 的 session
  - 存在 → 续接历史
source 用 hermes `--source` 标记 session 来源 (web / wechat / cli...) 方便 ops 过滤

基于 Nous Hermes Agent CLI 的非交互模式 (-Q -q)。
"""

import json
import os
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERMES_BIN = os.environ.get("HERMES_BIN", "hermes")
HERMES_TIMEOUT = int(os.environ.get("HERMES_TIMEOUT", "300"))  # 秒
DEFAULT_SESSION = os.environ.get("HERMES_DEFAULT_SESSION", "main")
DEFAULT_SOURCE = os.environ.get("HERMES_DEFAULT_SOURCE", "web")


def call_hermes(message: str, session_id: str, source: str) -> tuple[str, str, int]:
    """调用 Hermes CLI，返回 (stdout, stderr, returncode)"""
    args = [
        HERMES_BIN, "chat",
        "-Q",                         # quiet: 只输出最终回复 + session 信息
        "--continue", session_id,     # 按名字 resume,不存在则创建
        "--source", source,           # 标记 session 来源
        "-q", message,                # 单 query 非交互模式
    ]
    proc = subprocess.run(
        args,
        capture_output=True,
        text=True,
        timeout=HERMES_TIMEOUT,
    )
    return proc.stdout, proc.stderr, proc.returncode


class Handler(BaseHTTPRequestHandler):
    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            self._json(200, {"status": "ok"})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        if self.path != "/chat":
            self._json(404, {"error": "not found"})
            return

        length = int(self.headers.get("Content-Length", "0"))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._json(400, {"error": "invalid json"})
            return

        message = (body.get("message") or "").strip()
        if not message:
            self._json(400, {"error": "missing 'message'"})
            return

        session_id = (body.get("session_id") or DEFAULT_SESSION).strip()
        source = (body.get("source") or DEFAULT_SOURCE).strip()

        try:
            stdout, stderr, code = call_hermes(message, session_id, source)
        except subprocess.TimeoutExpired:
            self._json(504, {"error": "hermes timeout"})
            return
        except FileNotFoundError:
            self._json(500, {"error": f"hermes binary not found ({HERMES_BIN})"})
            return

        reply = stdout.strip() or stderr.strip()
        self._json(200, {"reply": reply, "session_id": session_id, "exit_code": code})

    # 安静日志
    def log_message(self, format, *args):  # noqa: A002
        print(f"[server] {self.address_string()} - {format % args}", flush=True)


def main():
    port = int(os.environ.get("PORT", "8080"))
    print(f"[server] listening on 0.0.0.0:{port}", flush=True)
    # ThreadingHTTPServer: 每个请求一个线程，避免长跑的 /chat 阻塞 /health
    # 这对 Azure Container Apps 的 readiness/liveness probe 至关重要 ——
    # 单线程 HTTPServer 在处理 chat 时 probe 会超时，5 次失败后 container 被强杀。
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
