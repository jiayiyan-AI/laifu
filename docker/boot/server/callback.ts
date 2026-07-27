import {
  CALLBACK_MAX_RETRIES,
  GATEWAY_BASE_URL,
  HEARTBEAT_INTERVAL_MS,
  LAIFU_USER_TOKEN,
} from './config.ts';
import { log } from './logger.ts';
import { getTraceId } from './trace-context.ts';
import type { AgentRuntime, ContainerChatUsage } from '../../runtime/types.ts';
import { httpJsonRetry } from '../scripts/lib.ts';

interface CallbackHeartbeatPayload {
  type: 'heartbeat';
  loop_id: string;
}

interface CallbackResultPayload {
  type: 'result';
  loop_id: string;
  reply: string;
  exit_code: number;
  hermes_session_id: string | null;
  usage: ContainerChatUsage;
}

type CallbackPayload = CallbackHeartbeatPayload | CallbackResultPayload;

export async function runAsyncChatAndCallback(
  runtime: AgentRuntime,
  message: string,
  sessionId: string,
  source: string,
  loopId: string,
): Promise<void> {
  const heartbeat = setInterval(() => {
    postCallback({ type: 'heartbeat', loop_id: loopId }).catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);

  try {
    const result = await runtime.run({ message, sessionId, source, loopId });
    await postCallback({
      type: 'result',
      loop_id: loopId,
      reply: result.reply,
      exit_code: result.exitCode,
      hermes_session_id: result.sessionId,
      usage: result.usage,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await postCallback({
      type: 'result',
      loop_id: loopId,
      reply: message || '处理失败，请稍后再试。',
      exit_code: 1,
      hermes_session_id: null,
      usage: emptyUsage(),
    });
  } finally {
    clearInterval(heartbeat);
  }
}

function emptyUsage(): ContainerChatUsage {
  return {
    model: null,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    provider: 'unknown',
  };
}

async function postCallback(payload: CallbackPayload): Promise<void> {
  if (!GATEWAY_BASE_URL || !LAIFU_USER_TOKEN) {
    log.warn({ event: 'callback.skipped', reason: 'gateway_base_url_or_token_unset', type: payload.type });
    return;
  }

  const url = `${GATEWAY_BASE_URL.replace(/\/+$/, '')}/internal/hermes-callback`;
  try {
    await httpJsonRetry(
      {
        method: 'POST',
        url,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${LAIFU_USER_TOKEN}`,
          ...(getTraceId() ? { 'X-Trace-Id': getTraceId()! } : {}),
        },
        body: payload,
        timeoutMs: 15_000,
      },
      CALLBACK_MAX_RETRIES - 1,
    );
    log.info({ event: 'callback.ok', type: payload.type, loop_id: payload.loop_id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ event: 'callback.failed', type: payload.type, loop_id: payload.loop_id, err: message });
  }
}
