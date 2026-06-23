// http.ts — HTTP 路由 handler (Request → Response, Bun.serve 形态)
//
// 暴露一个 `handle(req)` 给 index.ts 装到 Bun.serve.fetch 上。
// 内部按 method + pathname 分发到 5 个子 handler:
//   GET    /health      → 200 {status:"ok"}  (ACA probe 用, 不校 Bearer)
//   GET    /history     → 200 {messages:[{role,content,ts}]}
//   POST   /chat        → 同步: 200 + reply / 异步: 202 + 后台跑
//   POST   /inbox/image → 200 {path, size, content_type}  (streaming 收微信图片, 见 inbox.ts)
//   DELETE /session     → 200 {ok, deleted, hermes_session_id?} (清掉 hermes state.db 里的 session)
//
// 除 /health 外, 4 个业务端点统一过 requireBearer (auth.ts) 校验 LAIFU_USER_TOKEN。
//
// /history 和 /session 直接组合 session-map + state-db / hermes-proc,
// 不在 state-db 里耦合; state-db 保持纯 SQLite。
//
// 用 `Response.json()` (web 标准 ResponseInit overload) 收敛序列化, 不再手写
// Content-Type / Content-Length — Bun.serve 自动算。

import {
  DEFAULT_SESSION,
  DEFAULT_SOURCE,
  HERMES_BIN,
  HERMES_PROVIDER,
} from './config.ts';
import { getHermesId, delHermesId } from './session-map.ts';
import { loadMessagesByUuid } from './state-db.ts';
import { cleanReply, runHermes, hermesSubprocessBaseEnv } from './hermes-proc.ts';
import { callHermes, asyncChatAndCallback } from './chat.ts';
import { requireBearer } from './auth.ts';
import { handleInboxImage } from './inbox.ts';
import { log } from './logger.ts';
import { applyEntitlements } from '../scripts/sync-entitlements.ts';

// `hermes sessions delete` 是纯 SQLite 操作 (state.db 里 sessions/messages 几条 UPDATE),
// 正常 < 1s; 15s 上限只防 state.db 被 hermes writer 长锁的极端情况。
const SESSION_DELETE_TIMEOUT_MS = 15_000;

export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === 'GET' && url.pathname === '/health') return handleHealth();

  // 业务端点统一 Bearer 校验 (/health 留给 ACA probe 不校, 见 auth.ts)
  const denied = requireBearer(req);
  if (denied) return denied;

  if (req.method === 'POST' && url.pathname === '/internal/resync-entitlements') return handleResyncEntitlements(req);
  if (req.method === 'GET' && url.pathname === '/history') return handleHistory(url);
  if (req.method === 'POST' && url.pathname === '/chat') return handleChat(req);
  if (req.method === 'POST' && url.pathname === '/inbox/image') return handleInboxImage(req);
  if (req.method === 'DELETE' && url.pathname === '/session') return handleDeleteSession(url);
  return Response.json({ error: 'not found' }, { status: 404 });
}

function handleHealth(): Response {
  return Response.json({ status: 'ok' });
}

async function handleHistory(url: URL): Promise<Response> {
  const sessionName = (url.searchParams.get('session_id') ?? DEFAULT_SESSION).trim();
  if (!sessionName) return Response.json({ error: "missing 'session_id'" }, { status: 400 });
  try {
    const uuid = await getHermesId(sessionName);
    const messages = uuid ? loadMessagesByUuid(uuid) : [];
    return Response.json({ messages });
  } catch (e) {
    log.error({ event: 'history.load.failed', err: (e as Error).message });
    return Response.json({ error: 'load_history failed' }, { status: 500 });
  }
}

interface ChatRequestBody {
  message?: string;
  session_id?: string;
  source?: string;
  callback?: { loop_id?: string } | null;
}

async function handleChat(req: Request): Promise<Response> {
  let body: ChatRequestBody;
  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    return Response.json({ error: 'invalid json' }, { status: 400 });
  }

  const message = (body.message ?? '').trim();
  if (!message) return Response.json({ error: "missing 'message'" }, { status: 400 });

  const sessionId = (body.session_id ?? DEFAULT_SESSION).trim();
  const source = (body.source ?? DEFAULT_SOURCE).trim();
  const callback = body.callback;

  // 异步模式: 带 callback.loop_id 时立即 202, 后台跑;
  // fire-and-forget 的 promise 在 event loop 里独立活, 不被 fetch 返回影响。
  // 任何异常 asyncChatAndCallback 内部已经吃掉, .catch 是兜底防 unhandled rejection。
  if (callback && typeof callback === 'object' && callback.loop_id) {
    const loopId = callback.loop_id;
    asyncChatAndCallback(message, sessionId, source, loopId).catch((e) => {
      log.error({ event: 'chat.async.unhandled', loop_id: loopId, err: (e as Error).message });
    });
    return Response.json({ accepted: true }, { status: 202 });
  }

  // 同步模式 (向后兼容)
  try {
    const { stdout, stderr, exitCode, resolved, usage, timedOut } = await callHermes(
      message,
      sessionId,
      source,
    );
    if (timedOut) {
      return Response.json({ error: 'hermes timeout' }, { status: 504 });
    }
    return Response.json({
      reply: cleanReply(stdout) || stderr.trim() || '',
      session_id: sessionId,
      hermes_session_id: resolved,
      exit_code: exitCode,
      usage: { ...usage, provider: HERMES_PROVIDER },
    });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return Response.json({ error: `hermes binary not found (${HERMES_BIN})` }, { status: 500 });
    }
    return Response.json({ error: err.message ?? String(e) }, { status: 500 });
  }
}

// DELETE /session?session_id=<gateway_name>
//
// 行为:
//  1. 查 gateway_name → hermes_uuid 映射
//     - 无映射: 200 {ok:true, deleted:false} (幂等, gateway 看到 ok=true 就可以放心删 DB 行)
//  2. 跑 `hermes sessions delete <uuid> --yes` (15s 超时)
//     - 退出码 0: 摘掉 session-map 那条记录 → 200 {ok:true, deleted:true, hermes_session_id}
//     - 失败 / 超时: 不动 session-map → 500, gateway 决定是否仍 fallback 删 DB
//
// 不接 body, session_id 走 query string (跟 GET /history 一致)。
async function handleDeleteSession(url: URL): Promise<Response> {
  const sessionName = (url.searchParams.get('session_id') ?? '').trim();
  if (!sessionName) return Response.json({ error: "missing 'session_id'" }, { status: 400 });

  const uuid = await getHermesId(sessionName);
  if (!uuid) {
    return Response.json({ ok: true, deleted: false });
  }

  try {
    // `hermes sessions delete <id> --yes` — 跟 chat 同走 runHermes (detached + 进程组),
    // 操作很轻量但用同一条路径方便日志/超时一致。env 用 hermesSubprocessBaseEnv (抹掉
    // GATEWAY_SECRET); 无需 buildSubprocessEnv 那套 yolo / provider 映射 (跟 sessions 子命令无关)。
    const { exitCode, stderr, timedOut } = await runHermes(
      ['sessions', 'delete', uuid, '--yes'],
      hermesSubprocessBaseEnv(),
      SESSION_DELETE_TIMEOUT_MS,
    );
    if (timedOut) {
      log.error({ event: 'session.delete', session: sessionName, hermes_session_id: uuid, status: 'timeout' });
      return Response.json({ error: 'hermes sessions delete timeout' }, { status: 504 });
    }
    if (exitCode !== 0) {
      log.error({ event: 'session.delete', session: sessionName, hermes_session_id: uuid, status: 'error', exit_code: exitCode, stderr: stderr.trim() });
      return Response.json(
        { error: `hermes sessions delete exit ${exitCode}`, stderr: stderr.trim() },
        { status: 500 },
      );
    }
    await delHermesId(sessionName);
    log.info({ event: 'session.delete', session: sessionName, hermes_session_id: uuid, status: 'ok' });
    return Response.json({ ok: true, deleted: true, hermes_session_id: uuid });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return Response.json({ error: `hermes binary not found (${HERMES_BIN})` }, { status: 500 });
    }
    log.error({ event: 'session.delete', session: sessionName, status: 'error', err: err.message ?? String(e) });
    return Response.json({ error: err.message ?? String(e) }, { status: 500 });
  }
}

interface ResyncRequestBody {
  entitlements?: string[];
  token_version?: number;
}

// POST /internal/resync-entitlements
//
// gateway 装备能力时推一份 desired 过来, 容器声明式建/删软链后在同一响应回 observed。
// 不回调 gateway、不重启 —— 软链即生效 (Hermes CLI 每条消息现 spawn 时重读 ~/.hermes/skills)。
// 过 requireBearer (与其它业务端点同, 见 handle()); 不校 token_version, 故能收 gateway 现签 token。
// apply 参数默认 applyEntitlements, 单测注入假实现避免碰真 FS。
export async function handleResyncEntitlements(
  req: Request,
  apply: (desired: string[]) => string[] = applyEntitlements,
): Promise<Response> {
  let body: ResyncRequestBody;
  try {
    body = (await req.json()) as ResyncRequestBody;
  } catch {
    return Response.json({ error: 'invalid json' }, { status: 400 });
  }
  const desired = Array.isArray(body.entitlements) ? body.entitlements : [];
  const tokenVersion = typeof body.token_version === 'number' ? body.token_version : 0;
  try {
    const observed = apply(desired);
    return Response.json({ observed, token_version: tokenVersion });
  } catch (e) {
    log.error({ event: 'resync.entitlements.failed', err: (e as Error).message });
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
