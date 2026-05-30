"""
server.py — Hermes HTTP 包装层

接口:
  GET  /health  → 健康检查
  POST /chat    → body: {"message": "...", "session_id": "...", "source": "..."}
                  返回 {"reply": "...", "session_id": "...", "exit_code": 0}

session 管理:
  Hermes CLI 的 --continue/--resume 都不会"按名字创建新 session"——
  --continue 找不到 name 会报错,--resume 必须给已有的 UUID。
  所以本层维护一个 {gateway_session_name → hermes_session_uuid} 映射,
  持久化在 /home/hermes/.hermes/_gateway_session_map.json (落在用户 volume,
  容器重启不丢)。

  首次请求 (gateway_session_name 不在 map):
    1) 不带 --resume,bare hermes chat → Hermes 自动建一个新 session
    2) 从 stdout 解析新 session_id,失败则 hermes sessions list 取 newest
    3) 存进 map
  后续请求 (在 map):
    --resume <uuid> 续接历史

  并发安全靠一把 Lock + 原子 rename 写文件。同一用户的多线程消息会串行
  访问 map,这是有意为之 (避免两个 chat 同时在同一 session 写历史)。

基于 Nous Hermes Agent CLI 的非交互模式 (-Q -q)。
"""

import json
import os
import re
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock
from urllib.parse import urlparse, parse_qs

HERMES_BIN = os.environ.get("HERMES_BIN", "hermes")
HERMES_TIMEOUT = int(os.environ.get("HERMES_TIMEOUT", "300"))  # 秒
DEFAULT_SESSION = os.environ.get("HERMES_DEFAULT_SESSION", "main")
DEFAULT_SOURCE = os.environ.get("HERMES_DEFAULT_SOURCE", "web")

# 持久化在用户 home 下,跟用户数据一起活
SESSION_MAP_FILE = os.path.expanduser("~/.hermes/_gateway_session_map.json")
_map_lock = Lock()


def _load_map() -> dict:
    if not os.path.exists(SESSION_MAP_FILE):
        return {}
    try:
        with open(SESSION_MAP_FILE) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def _save_map(m: dict) -> None:
    os.makedirs(os.path.dirname(SESSION_MAP_FILE), exist_ok=True)
    tmp = SESSION_MAP_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(m, f, indent=2, ensure_ascii=False)
    os.replace(tmp, SESSION_MAP_FILE)


def _get_hermes_id(name: str) -> str | None:
    with _map_lock:
        return _load_map().get(name)


def _put_hermes_id(name: str, hermes_id: str) -> None:
    with _map_lock:
        m = _load_map()
        m[name] = hermes_id
        _save_map(m)


# UUID / ULID / 通用长 ID 的几种格式
_ID_PATTERNS = [
    re.compile(r"\b([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b"),
    re.compile(r"\b([0-9A-Z]{26})\b"),                       # ULID
    re.compile(r"\b([a-zA-Z0-9_-]{16,})\b"),                  # 通用长 token
]


def _extract_id_near_keyword(text: str) -> str | None:
    """从 'session_id: xxx' / 'Session: xxx' / '[session xxx]' 等位置抓 ID。
    Hermes 的 session_id 格式是 YYYYMMDD_HHMMSS_<hash>,含下划线。"""
    for pat in [
        re.compile(r"[Ss]ession(?:[ _-]?id)?\s*[:=]\s*([A-Za-z0-9_-]{8,})"),
        re.compile(r"\[session\s+([A-Za-z0-9_-]{8,})\]"),
        re.compile(r"resume\s+(?:with\s+)?([A-Za-z0-9_-]{8,})"),
    ]:
        m = pat.search(text)
        if m:
            return m.group(1)
    return None


def _newest_session_id_via_list(source: str) -> str | None:
    """Hermes 输出里没找到 ID 时,fallback 走 sessions list 拿 newest。"""
    try:
        proc = subprocess.run(
            [HERMES_BIN, "sessions", "list", "--source", source, "--limit", "1"],
            capture_output=True, text=True, timeout=15,
        )
        if proc.returncode != 0:
            return None
        out = proc.stdout
        # 先按 keyword 找
        sid = _extract_id_near_keyword(out)
        if sid:
            return sid
        # 退化:任何 ID-like token
        for pat in _ID_PATTERNS:
            m = pat.search(out)
            if m:
                return m.group(1)
        return None
    except Exception as e:
        print(f"[server] sessions list failed: {e}", flush=True)
        return None


def _detect_new_session_id(stdout: str, stderr: str, source: str) -> str | None:
    """优先从 chat 的 stdout/stderr 提取;失败 fallback 到 sessions list。"""
    for text in (stdout, stderr):
        sid = _extract_id_near_keyword(text)
        if sid:
            return sid
    return _newest_session_id_via_list(source)


def _clean_reply(stdout: str) -> str:
    """剔除 Hermes 的 warning/info 行,只留真正的 LLM 回复。

    Hermes -Q 模式会输出:
      ⚠️ Normalized model 'anthropic/claude-sonnet-4-20250514' to
      'claude-sonnet-4-20250514' for anthropic.            ← wrap 续行,无缩进
        ⚠ tirith security scanner enabled but not available ...
      session_id: YYYYMMDD_HHMMSS_<hash>
      <真正的回复>

    策略:
    - ⚠️ / ⚠ / [server] 开头的行 → 整行丢
    - 如果该 warning 行末尾以 " to" / " to " 结束,显式吞掉下一行 (wrap 续接)
    - session_id 元信息行 → 丢"""
    lines = stdout.splitlines()
    keep: list[str] = []
    skip_next = False
    for line in lines:
        if skip_next:
            skip_next = False
            continue
        stripped = line.lstrip()
        if stripped.startswith(("⚠️", "⚠", "[server]")):
            # 末尾以 " to" 结束的 warning 是换行 wrap 的,下一行属于同一个 warning
            if line.rstrip().endswith(" to"):
                skip_next = True
            continue
        if stripped.startswith(("session_id:", "Session ID:")):
            continue
        keep.append(line)
    return "\n".join(keep).strip()


def load_history(session_name: str) -> list[dict]:
    """读出某 gateway session_name 的全部 user/assistant 消息。

    照搬 Hermes 上游 web_server.py 的 /api/sessions/{id}/messages 写法 ——
    直接 from hermes_state import SessionDB, db.get_messages(uuid)。
    比 subprocess 调 'hermes sessions export' 快几个数量级,也省解析。

    返回形如 [{"role": "user"|"assistant", "content": "...", "ts": float}],
    按时间排序。空 session (从未发过消息) 返回 []。"""
    uuid = _get_hermes_id(session_name)
    if not uuid:
        return []
    # 延迟 import:hermes_state 比较重,只在调到 /history 时再加载
    from hermes_state import SessionDB  # type: ignore
    db = SessionDB()
    try:
        rows = db.get_messages(uuid)
    finally:
        db.close()
    out: list[dict] = []
    for r in rows:
        role = r.get("role")
        content = r.get("content")
        # 跳过 tool 调用 (assistant 带 tool_calls 但 content 是占位)、tool 返回
        if role not in ("user", "assistant"):
            continue
        if r.get("tool_calls"):
            continue
        if not content:
            continue
        out.append({
            "role": role,
            "content": content,
            "ts": r.get("timestamp"),
        })
    return out


def call_hermes(message: str, session_name: str, source: str) -> tuple[str, str, int, str | None]:
    """返回 (stdout, stderr, returncode, resolved_hermes_id)。"""
    existing = _get_hermes_id(session_name)

    args = [HERMES_BIN, "chat", "-Q"]
    if existing:
        args += ["--resume", existing]
    args += ["--source", source, "-q", message]

    proc = subprocess.run(
        args, capture_output=True, text=True, timeout=HERMES_TIMEOUT,
    )

    resolved = existing
    if not existing and proc.returncode == 0:
        new_id = _detect_new_session_id(proc.stdout, proc.stderr, source)
        if new_id:
            _put_hermes_id(session_name, new_id)
            resolved = new_id
            print(f"[server] mapped {session_name} → {new_id}", flush=True)
        else:
            print(f"[server] could NOT find hermes_session_id for {session_name}",
                  flush=True)

    return proc.stdout, proc.stderr, proc.returncode, resolved


class Handler(BaseHTTPRequestHandler):
    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._json(200, {"status": "ok"})
            return
        if parsed.path == "/history":
            q = parse_qs(parsed.query)
            session_name = (q.get("session_id", [DEFAULT_SESSION])[0] or "").strip()
            if not session_name:
                self._json(400, {"error": "missing 'session_id'"})
                return
            try:
                msgs = load_history(session_name)
            except Exception as e:  # noqa: BLE001
                print(f"[server] load_history failed: {e}", flush=True)
                self._json(500, {"error": "load_history failed"})
                return
            self._json(200, {"messages": msgs})
            return
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
            stdout, stderr, code, resolved = call_hermes(message, session_id, source)
        except subprocess.TimeoutExpired:
            self._json(504, {"error": "hermes timeout"})
            return
        except FileNotFoundError:
            self._json(500, {"error": f"hermes binary not found ({HERMES_BIN})"})
            return

        reply = _clean_reply(stdout) or stderr.strip()
        self._json(200, {
            "reply": reply,
            "session_id": session_id,           # gateway 视角的 name
            "hermes_session_id": resolved,      # hermes UUID,可能 None (第一次没解析到)
            "exit_code": code,
        })

    def log_message(self, format, *args):  # noqa: A002
        print(f"[server] {self.address_string()} - {format % args}", flush=True)


def main():
    port = int(os.environ.get("PORT", "8080"))
    print(f"[server] listening on 0.0.0.0:{port}", flush=True)
    # ThreadingHTTPServer: 每个请求一个线程,避免长跑的 /chat 阻塞 /health。
    # 这对 Azure Container Apps 的 readiness/liveness probe 至关重要 ——
    # 单线程 HTTPServer 在处理 chat 时 probe 会超时,5 次失败后 container 被强杀。
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
