// chat.ts — 编排层: 串起 hermes 子进程 + state.db snapshot + session map + gateway callback
//
// 两个对外入口:
//   callHermes(message, sessionName, source)   同步: 跑 hermes, 返回 {stdout, stderr,
//                                              exitCode, resolved, usage, timedOut}
//   asyncChatAndCallback(message, sessionName, source, loopId)
//                                              异步: 心跳 + result callback 回 gateway
//
// fire-and-forget: HTTP handler 立即 202 返回后, asyncChatAndCallback 在 event loop
// 后台跑, 异常 try/catch 自包含; callback 失败也只打日志, 不影响 server 继续服务。

import {
  HERMES_TIMEOUT_MS,
  HERMES_PROVIDER,
  HEARTBEAT_INTERVAL_MS,
  CALLBACK_MAX_RETRIES,
  GATEWAY_BASE_URL,
  LAIFU_USER_TOKEN,
} from './config.ts';
import { getHermesId, putHermesId } from './session-map.ts';
import { snapshotSession, usageDelta } from './state-db.ts';
import type { Snapshot } from './state-db.ts';
import { runHermes, buildSubprocessEnv, detectNewSessionId, cleanReply } from './hermes-proc.ts';
import { httpJsonRetry } from '/opt/lingxi-scripts/lib.ts';

export interface CallHermesResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  resolved: string | null;
  usage: Snapshot;
  timedOut: boolean;
}

export async function callHermes(
  message: string,
  sessionName: string,
  source: string,
): Promise<CallHermesResult> {
  const existing = await getHermesId(sessionName);
  const before = snapshotSession(existing);

  // --yolo: 绕过 "dangerous command" 审批弹窗. 容器里没 TTY,
  // 不加这个 flag 时 LLM 一旦想跑 pnpm/git/rm 等会被 hermes 拦住等审批,
  // 在非交互模式下表现为「助理只输出 tool 调用前那段文本就收尾」,
  // 用户感知就是 "让我来 X:" 之后没下文。
  // 我们的部署是单用户隔离容器, 没有人审批, --yolo 是正确语义。
  const args = ['chat', '-Q', '--yolo'];
  if (existing) args.push('--resume', existing);
  args.push('--source', source, '-q', message);

  const env = await buildSubprocessEnv();
  const { stdout, stderr, exitCode, timedOut } = await runHermes(args, env, HERMES_TIMEOUT_MS);

  let resolved: string | null = existing;
  if (!existing && exitCode === 0) {
    const newId = await detectNewSessionId(stdout, stderr, source);
    if (newId) {
      await putHermesId(sessionName, newId);
      resolved = newId;
      console.log(`[server] mapped ${sessionName} → ${newId}`);
    } else {
      console.log(`[server] could NOT find hermes_session_id for ${sessionName}`);
    }
  }

  const after = snapshotSession(resolved);
  const usage = usageDelta(before, after);

  return { stdout, stderr, exitCode, resolved, usage, timedOut };
}

export interface CallbackResultPayload {
  type: 'result';
  loop_id: string;
  reply: string;
  exit_code: number;
  hermes_session_id: string | null;
  usage: Snapshot & { provider: string };
}

export interface CallbackHeartbeatPayload {
  type: 'heartbeat';
  loop_id: string;
}

export type CallbackPayload = CallbackResultPayload | CallbackHeartbeatPayload;

export async function asyncChatAndCallback(
  message: string,
  sessionName: string,
  source: string,
  loopId: string,
): Promise<void> {
  const hb = setInterval(() => {
    postCallback({ type: 'heartbeat', loop_id: loopId }).catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);

  let stdout = '';
  let stderr = '';
  let exitCode = 1;
  let resolved: string | null = null;
  let usage: Snapshot | undefined;
  let timedOut = false;

  try {
    const r = await callHermes(message, sessionName, source);
    ({ stdout, stderr, exitCode, resolved, usage, timedOut } = r);
  } catch (e) {
    stderr = (e as Error).message ?? String(e);
    exitCode = 1;
  } finally {
    clearInterval(hb);
  }

  let reply: string;
  if (timedOut) {
    reply = 'hermes timeout';
    exitCode = 1;
  } else {
    reply = cleanReply(stdout) || stderr.trim() || '';
  }

  await postCallback({
    type: 'result',
    loop_id: loopId,
    reply,
    exit_code: exitCode,
    hermes_session_id: resolved,
    usage: { ...(usage ?? ({} as Snapshot)), provider: HERMES_PROVIDER },
  });
}

// POST 回调 gateway, 带重试 (httpJsonRetry 默认 exp backoff 1s/2s/4s)
async function postCallback(payload: CallbackPayload): Promise<void> {
  if (!GATEWAY_BASE_URL || !LAIFU_USER_TOKEN) {
    console.log('[server] callback skipped: GATEWAY_BASE_URL or LAIFU_USER_TOKEN not set');
    return;
  }

  const url = `${GATEWAY_BASE_URL.replace(/\/+$/, '')}/internal/hermes-callback`;
  try {
    // httpJsonRetry: retries=N → 共 N+1 次尝试, 所以传 CALLBACK_MAX_RETRIES-1
    await httpJsonRetry(
      {
        method: 'POST',
        url,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${LAIFU_USER_TOKEN}`,
        },
        body: payload,
        timeoutMs: 15_000,
      },
      CALLBACK_MAX_RETRIES - 1,
    );
    console.log(`[server] callback ok (${payload.type})`);
  } catch (e) {
    console.error(`[server] callback exhausted all retries: ${(e as Error).message}`);
  }
}
