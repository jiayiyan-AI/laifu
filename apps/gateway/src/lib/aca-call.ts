/**
 * 调用每用户 hermes ACA 的 /chat 时做指标埋点。
 *
 * 只测 chat 本身, 不再额外打 /health probe (那会让所有请求多一次 RTT, 得不偿失)。
 * 冷启动判断: 直接查 ContainerAppSystemLogs_CL 里 scaler 0→1 / 容器创建事件,
 * 按时间戳跟 aca.chat.call 对齐, 见 docs/observability.md。
 *
 * 字段:
 *  - chat_ms: POST /chat 端到端耗时
 *  - reply_chars: 回复字符数, 配合 chat_ms 看吞吐
 *  - status: ok | no_reply | http_<code> | error
 *  - user_id / thread_id / source: 切片维度
 *
 * 日志格式: 单行 JSON, 走 stdout → App Service → Log Analytics
 *           AppServiceConsoleLogs.ResultDescription。
 *
 * 失败也打: status=http_<code> | error, 便于按 status 分组算成功率。
 *
 * 不做指数退避 / 重试; 调用方 (chat.ts / inbound-handler) 已有自己的兜底文案。
 */
import type { ContainerChatResponse, ContainerChatUsage } from '@lingxi/shared';
import { log } from './logger.js';

interface CallArgs {
  containerUrl: string;
  userId: string;
  threadId: string;
  source: string;            // 'web' | 'wechat'
  sessionId: string;
  message: string;
  /** 注入用; 测试里替成 vi.fn 控制 hermes 行为。生产走全局 fetch。 */
  fetchImpl?: typeof fetch;
}

export interface CallResult {
  ok: boolean;
  status: number;            // 0 表示网络/抛错没拿到 HTTP code
  reply?: string;
  error?: string;
  usage?: ContainerChatUsage; // 透出 hermes 本轮 token 消耗, 调用方负责落库
}

const now = (): number => performance.now();

export const callHermesChat = async (args: CallArgs): Promise<CallResult> => {
  const { containerUrl, userId, threadId, source, sessionId, message } = args;
  const fetcher = args.fetchImpl ?? fetch;

  const chatStart = now();
  try {
    const resp = await fetcher(`${containerUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, session_id: sessionId, source }),
    });
    const chatMs = Math.round(now() - chatStart);
    if (!resp.ok) {
      log.warn({
        event: 'aca.chat.call',
        user_id: userId,
        thread_id: threadId,
        source,
        chat_ms: chatMs,
        status: `http_${resp.status}`,
      });
      return { ok: false, status: resp.status };
    }
    const body = await resp.json() as ContainerChatResponse;
    const reply = typeof body.reply === 'string' ? body.reply : undefined;
    const usage = body.usage;
    log.info({
      event: 'aca.chat.call',
      user_id: userId,
      thread_id: threadId,
      source,
      chat_ms: chatMs,
      reply_chars: reply?.length ?? 0,
      status: reply ? 'ok' : 'no_reply',
      // token 字段: server/index.ts (前身 server.py PR1) 稳定下发; 旧镜像 undefined 不进日志即可
      provider: usage?.provider ?? undefined,
      model: usage?.model ?? undefined,
      input_tokens: usage?.input_tokens,
      output_tokens: usage?.output_tokens,
      cache_read_tokens: usage?.cache_read_tokens,
      cache_write_tokens: usage?.cache_write_tokens,
      reasoning_tokens: usage?.reasoning_tokens,
    });
    return reply
      ? { ok: true, status: resp.status, reply, usage }
      : { ok: false, status: resp.status, error: 'missing reply', usage };
  } catch (e) {
    const chatMs = Math.round(now() - chatStart);
    const err = e instanceof Error ? e.message : String(e);
    log.error({
      event: 'aca.chat.call',
      user_id: userId,
      thread_id: threadId,
      source,
      chat_ms: chatMs,
      status: 'error',
      err,
    });
    return { ok: false, status: 0, error: err };
  }
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
  fetchImpl?: typeof fetch;
}

export interface DispatchResult {
  ok: boolean;
  status: number;
  error?: string;
}

export const dispatchHermesChat = async (args: DispatchArgs): Promise<DispatchResult> => {
  const { containerUrl, userId, threadId, source, sessionId, message, loopId } = args;
  const fetcher = args.fetchImpl ?? fetch;
  try {
    const resp = await fetcher(`${containerUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    if (resp.status === 202) return { ok: true, status: 202 };
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
