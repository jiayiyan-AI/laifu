/**
 * Gateway → 每用户 hermes ACA 的出站调用 (异步 /chat dispatch + DELETE /session)
 * 与共用的 per-user Bearer 签发 (getContainerToken)。
 *
 * 每次出站前 checkAndReconcileACA(userId): spec 漂移则后台拉齐 (幂等去重, 非阻塞,
 * 本次仍走老 revision)。出站 2xx 后 noteContainerActivity 续 warm-cache。
 *
 * 日志: 单行 JSON → stdout → App Service → Log Analytics。
 *  - aca.chat.dispatch: status=202 ack / http_<code> / 0 (error)
 *  - aca.session.delete: status=ok / http_<code> / error, deleted 标记幂等命中
 *
 * 不做指数退避 / 重试; 调用方 (chat.ts / threads.ts / inbound-handler) 已有兜底文案。
 */
import { log } from './logger.js';
import { checkAndReconcileACA } from '../provisioning/reconcile.js';
import { signLaifuUserToken } from './gateway-token.js';
import { config } from '../config.js';
import { dao } from '../db/index.js';
import { noteContainerActivity } from './container-warm-cache.js';
import { getTraceId } from './trace-context.js';

/** 出站到容器时把当前 trace_id 透传成 header, 让容器侧日志归到同一 trace。无上下文则不带。 */
const traceHeader = (): Record<string, string> => {
  const t = getTraceId();
  return t ? { 'X-Trace-Id': t } : {};
};

/**
 * 给出站容器请求签一个 per-user Bearer token (4 个出站函数 + inbox-uploader 共用)。
 * token_version 取 DB 当前值; 缺失 (无 user 行) 抛错, 让调用方按各自语义兜底。
 * 不缓存: 稳态下 user 不会频繁刷新, 每次 1 select 可接受。
 */
export const getContainerToken = async (userId: string): Promise<string> => {
  const v = await dao.users.getTokenVersion(userId);
  if (v == null) throw new Error(`no token_version for user ${userId}`);
  return signLaifuUserToken({ userId, tokenVersion: v, secret: config.auth.gatewaySecret });
};

// === Async dispatch (fire-and-forget, 只等 202 ack) ===

interface DispatchArgs {
  containerUrl: string;
  userId: string;
  threadId: string;
  source: string;
  sessionId: string;
  message: string;
  loopId: string;
}

export interface DispatchResult {
  ok: boolean;
  status: number;
  error?: string;
}

export const dispatchHermesChat = async (args: DispatchArgs): Promise<DispatchResult> => {
  const { containerUrl, userId, threadId, source, sessionId, message, loopId } = args;
  checkAndReconcileACA(userId);   // ACA 出口层统一触发 reconcile (幂等去重, 非阻塞, 本次仍走老 revision)
  try {
    const token = await getContainerToken(userId);
    const resp = await fetch(`${containerUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...traceHeader() },
      body: JSON.stringify({
        message,
        session_id: sessionId,
        source,
        callback: { loop_id: loopId },
      }),
    });
    log.info({
      event: 'aca.chat.dispatch',
      user_id: userId,
      thread_id: threadId,
      source,
      status: resp.status,
    });
    if (resp.status === 202) {
      noteContainerActivity(userId);   // 202 ack → 续 warm-cache
      return { ok: true, status: 202 };
    }
    return { ok: false, status: resp.status, error: `expected 202, got ${resp.status}` };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    log.error({
      event: 'aca.chat.dispatch',
      user_id: userId,
      thread_id: threadId,
      source,
      status: 0,
      err,
    });
    return { ok: false, status: 0, error: err };
  }
};

// === Session delete (gateway → container DELETE /session) ===

interface DeleteSessionArgs {
  containerUrl: string;
  userId: string;
  threadId: string;
  source: string;
  sessionId: string;
}

export interface DeleteSessionResult {
  ok: boolean;
  status: number;
  /** 容器侧是否真删了一行 (无映射时为 false; 跟 ok=true 共存代表幂等成功)。 */
  deleted?: boolean;
  hermesSessionId?: string;
  error?: string;
}

/**
 * 调容器 `DELETE /session?session_id=...` 清理 hermes state.db 里的 session + map 条目。
 *
 * 失败语义 (调用方按需处理):
 *  - 网络错误 / 非 2xx: ok=false, error 写明; gateway 仍会继续删 DB (best-effort 策略)
 *  - 容器返 ok=true 但 deleted=false: 容器侧没找到映射, 跟成功删等价
 *
 * 不重试: 容器侧已经是幂等的, 一次失败后让用户重试或后台兜底, 比阻塞 HTTP 更好。
 */
export const deleteHermesSession = async (args: DeleteSessionArgs): Promise<DeleteSessionResult> => {
  const { containerUrl, userId, threadId, source, sessionId } = args;
  checkAndReconcileACA(userId);   // ACA 出口层统一触发 reconcile (幂等去重, 非阻塞, 本次仍走老 revision)
  try {
    const url = `${containerUrl}/session?session_id=${encodeURIComponent(sessionId)}`;
    const token = await getContainerToken(userId);
    const resp = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, ...traceHeader() },
    });
    if (!resp.ok) {
      log.warn({
        event: 'aca.session.delete',
        user_id: userId,
        thread_id: threadId,
        source,
        status: `http_${resp.status}`,
      });
      return { ok: false, status: resp.status, error: `http ${resp.status}` };
    }
    noteContainerActivity(userId);   // 2xx → 续 warm-cache
    const body = await resp.json() as { ok?: boolean; deleted?: boolean; hermes_session_id?: string };
    log.info({
      event: 'aca.session.delete',
      user_id: userId,
      thread_id: threadId,
      source,
      status: 'ok',
      deleted: body.deleted ?? false,
      hermes_session_id: body.hermes_session_id ?? undefined,
    });
    return {
      ok: true,
      status: resp.status,
      deleted: body.deleted ?? false,
      hermesSessionId: body.hermes_session_id,
    };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    log.error({
      event: 'aca.session.delete',
      user_id: userId,
      thread_id: threadId,
      source,
      status: 'error',
      err,
    });
    return { ok: false, status: 0, error: err };
  }
};
