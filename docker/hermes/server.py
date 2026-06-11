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
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock, Thread, Event
from urllib.parse import urlparse, parse_qs
import urllib.request
import urllib.error

HERMES_BIN = os.environ.get("HERMES_BIN", "hermes")
HERMES_TIMEOUT = int(os.environ.get("HERMES_TIMEOUT", "300"))  # 秒
HERMES_PROVIDER = os.environ.get("HERMES_PROVIDER", "unknown")  # dashscope / anthropic / ...
DEFAULT_SESSION = os.environ.get("HERMES_DEFAULT_SESSION", "main")
DEFAULT_SOURCE = os.environ.get("HERMES_DEFAULT_SOURCE", "web")

# 异步回调配置
GATEWAY_BASE_URL = os.environ.get("GATEWAY_BASE_URL", "")

def _read_laifu_token() -> str:
    """先读 env, 再 fallback 文件 (与 bootstrap readToken 逻辑一致)."""
    from_env = os.environ.get("LAIFU_USER_TOKEN", "").strip()
    if from_env:
        return from_env
    token_file = os.path.expanduser("~/.hermes/.laifu_user_token")
    try:
        with open(token_file) as f:
            return f.read().strip()
    except OSError:
        return ""

LAIFU_USER_TOKEN = _read_laifu_token()
CALLBACK_MAX_RETRIES = 3
CALLBACK_BACKOFF = [2, 8, 30]  # 秒
HEARTBEAT_INTERVAL = 120  # 秒，每 2 分钟发一次心跳

# 持久化在用户 home 下,跟用户数据一起活
SESSION_MAP_FILE = os.path.expanduser("~/.hermes/_gateway_session_map.json")
_map_lock = Lock()

# 动态 system prompt: gateway 通过 /api/me/prompts/system-prompt.md 下发,
# bootstrap.mjs (sync-prompts) 写到这里, 每次 chat 由本进程现读现注入 hermes 子进程
# 的 HERMES_EPHEMERAL_SYSTEM_PROMPT。改 prompt 后 → gateway redeploy → 用户下次
# chat 自动拿到新版本 (前提是容器已经在线; 离线用户冷启动时由 sync-prompts 拉)。
DYN_SYSTEM_PROMPT_FILE = os.path.expanduser("~/dynamic_prompts/system-prompt.md")


def _build_subprocess_env() -> dict:
    """每次 chat 前现读 dynamic system prompt 文件, 注入 hermes 子进程的 env。

    - 文件存在且非空 → 设 HERMES_EPHEMERAL_SYSTEM_PROMPT, hermes 拼到 cached
      system prompt 之后 (cache 友好, 内容稳定就 byte-stable)。
    - 文件不存在或空 → 显式 unset, 避免吃到 server.py 启动时继承的旧值。
    - 文件读失败 → 当成不存在处理, 打日志, 不阻塞 chat。
    """
    env = os.environ.copy()
    try:
        with open(DYN_SYSTEM_PROMPT_FILE, encoding="utf-8") as f:
            content = f.read().strip()
        if content:
            env["HERMES_EPHEMERAL_SYSTEM_PROMPT"] = content
        else:
            env.pop("HERMES_EPHEMERAL_SYSTEM_PROMPT", None)
    except FileNotFoundError:
        env.pop("HERMES_EPHEMERAL_SYSTEM_PROMPT", None)
    except OSError as e:
        print(f"[server] read {DYN_SYSTEM_PROMPT_FILE} failed: {e}", flush=True)
        env.pop("HERMES_EPHEMERAL_SYSTEM_PROMPT", None)
    return env


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


# sessions 表里需要 snapshot 的 token 计数列 (累计值)。delta = after - before 即本轮 usage,
# 自动包含 tool loop 多轮 LLM 调用。列名跟 hermes_state.py 里 CREATE TABLE sessions 一致。
_TOKEN_COLS = ("input_tokens", "output_tokens", "cache_read_tokens",
               "cache_write_tokens", "reasoning_tokens")


def _snapshot_session(hermes_uuid: str | None) -> dict:
    """读一次 sessions 表的累计 token 计数 + model。不存在 / 读失败 → 全 0。

    失败不报错, 需要保证 chat 成功不会被计量逻辑拖死。"""
    base = {c: 0 for c in _TOKEN_COLS}
    base["model"] = None
    if not hermes_uuid:
        return base
    try:
        from hermes_state import SessionDB  # 延迟 import: 跟 load_history 一致
        db = SessionDB()
        try:
            row = db.get_session(hermes_uuid)
        finally:
            db.close()
        if not row:
            return base
        out = {c: int(row.get(c) or 0) for c in _TOKEN_COLS}
        out["model"] = row.get("model")
        return out
    except Exception as e:  # noqa: BLE001
        print(f"[server] snapshot_session({hermes_uuid}) failed: {e}", flush=True)
        return base


def _usage_delta(before: dict, after: dict) -> dict:
    """算 delta。model 优先取 after (中途 /model 切换以最后为准, 跟 dashboard 一致)。"""
    delta = {c: max(0, int(after.get(c) or 0) - int(before.get(c) or 0))
             for c in _TOKEN_COLS}
    delta["model"] = after.get("model") or before.get("model")
    return delta


def call_hermes(message: str, session_name: str, source: str) -> tuple[str, str, int, str | None, dict]:
    """返回 (stdout, stderr, returncode, resolved_hermes_id, usage_delta)。

    usage_delta 形状:
      {model, input_tokens, output_tokens, cache_read_tokens,
       cache_write_tokens, reasoning_tokens}
    首轮新 session 时 before 里拿不到行, 以零为 baseline; 后续轮以上轮累计为 baseline。
    这样 delta 就是本次 /chat 的真实消耗 (含多轮 tool loop)。"""
    existing = _get_hermes_id(session_name)
    before = _snapshot_session(existing)

    args = [HERMES_BIN, "chat", "-Q"]
    if existing:
        args += ["--resume", existing]
    args += ["--source", source, "-q", message]

    proc = subprocess.run(
        args, capture_output=True, text=True, timeout=HERMES_TIMEOUT,
        env=_build_subprocess_env(),
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

    after = _snapshot_session(resolved)
    usage = _usage_delta(before, after)

    return proc.stdout, proc.stderr, proc.returncode, resolved, usage


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
        callback = body.get("callback")

        # 异步模式: 带 callback 字段时立即 202, 后台线程跑 hermes + 回调
        if callback and isinstance(callback, dict) and callback.get("loop_id"):
            loop_id = callback["loop_id"]
            self._json(202, {"accepted": True})
            Thread(
                target=_async_chat_and_callback,
                args=(message, session_id, source, loop_id),
                daemon=True,
            ).start()
            return

        # 同步模式 (向后兼容)
        try:
            stdout, stderr, code, resolved, usage = call_hermes(message, session_id, source)
        except subprocess.TimeoutExpired:
            self._json(504, {"error": "hermes timeout"})
            return
        except FileNotFoundError:
            self._json(500, {"error": f"hermes binary not found ({HERMES_BIN})"})
            return

        reply = _clean_reply(stdout) or stderr.strip()
        # usage dict 加上 provider (从环境变量, 容器级别固定)
        if usage is not None:
            usage["provider"] = HERMES_PROVIDER
        self._json(200, {
            "reply": reply,
            "session_id": session_id,           # gateway 视角的 name
            "hermes_session_id": resolved,      # hermes UUID,可能 None (第一次没解析到)
            "exit_code": code,
            "usage": usage,                     # 本次 chat 的 token delta (包含 tool loop)
        })

    def log_message(self, format, *args):  # noqa: A002
        print(f"[server] {self.address_string()} - {format % args}", flush=True)


def _async_chat_and_callback(message: str, session_id: str, source: str, loop_id: str) -> None:
    """后台线程: 跑 hermes（并行发心跳）然后回调 gateway。"""
    # 启动心跳线程
    stop_heartbeat = Event()

    def heartbeat_loop():
        while not stop_heartbeat.wait(HEARTBEAT_INTERVAL):
            _post_callback({"type": "heartbeat", "loop_id": loop_id})

    hb_thread = Thread(target=heartbeat_loop, daemon=True)
    hb_thread.start()

    try:
        stdout, stderr, code, resolved, usage = call_hermes(message, session_id, source)
    except subprocess.TimeoutExpired:
        stdout, stderr, code, resolved, usage = "", "hermes timeout", 1, None, {}
    except FileNotFoundError:
        stdout, stderr, code, resolved, usage = "", "hermes binary not found", 1, None, {}
    except Exception as e:  # noqa: BLE001
        stdout, stderr, code, resolved, usage = "", str(e), 1, None, {}
    finally:
        stop_heartbeat.set()

    reply = _clean_reply(stdout) or stderr.strip()
    if usage is not None:
        usage["provider"] = HERMES_PROVIDER

    payload = {
        "type": "result",
        "loop_id": loop_id,
        "reply": reply,
        "exit_code": code,
        "hermes_session_id": resolved,
        "usage": usage,
    }

    _post_callback(payload)


def _post_callback(payload: dict) -> None:
    """POST 回调到 gateway, 带重试。"""
    if not GATEWAY_BASE_URL or not LAIFU_USER_TOKEN:
        print("[server] callback skipped: GATEWAY_BASE_URL or LAIFU_USER_TOKEN not set", flush=True)
        return

    url = f"{GATEWAY_BASE_URL.rstrip('/')}/internal/hermes-callback"
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": f"Bearer {LAIFU_USER_TOKEN}",
    }

    for attempt in range(CALLBACK_MAX_RETRIES):
        try:
            req = urllib.request.Request(url, data=data, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=15) as resp:
                if resp.status < 300:
                    print(f"[server] callback ok (attempt {attempt+1})", flush=True)
                    return
                print(f"[server] callback status {resp.status} (attempt {attempt+1})", flush=True)
        except (urllib.error.URLError, OSError) as e:
            print(f"[server] callback failed (attempt {attempt+1}): {e}", flush=True)

        if attempt < CALLBACK_MAX_RETRIES - 1:
            backoff = CALLBACK_BACKOFF[attempt] if attempt < len(CALLBACK_BACKOFF) else 30
            time.sleep(backoff)

    print(f"[server] callback exhausted all {CALLBACK_MAX_RETRIES} retries", flush=True)


def main():
    port = int(os.environ.get("PORT", "8080"))
    print(f"[server] listening on 0.0.0.0:{port}", flush=True)
    # ThreadingHTTPServer: 每个请求一个线程,避免长跑的 /chat 阻塞 /health。
    # 这对 Azure Container Apps 的 readiness/liveness probe 至关重要 ——
    # 单线程 HTTPServer 在处理 chat 时 probe 会超时,5 次失败后 container 被强杀。
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
