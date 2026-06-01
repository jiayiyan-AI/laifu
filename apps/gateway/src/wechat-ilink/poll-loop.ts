/**
 * 单账号 iLink 长轮询循环 —— PollManager 会 spawn 一个跑在背景。
 *
 * 协议:
 *   while not aborted:
 *     resp = client.getUpdates(cursor, timeout=35s, signal)
 *     if resp.errcode == -14: onSessionExpired() then return
 *     if resp.get_updates_buf changed: onCursorUpdate(new)
 *     for msg in resp.msgs: onMessage(msg)   # 单条 throw 不杀循环
 *   网络错: 指数退避 max 30s 重试,直到 abort
 *
 * AbortSignal 是退出闸:
 *   - 外部 stopOne / stopAll 会 abort
 *   - getUpdates 会感知到 (它内部 AbortSignal.any 合并了 signal + timeout)
 *   - sleep 也得感知到,否则退避期间不能停
 */
import type { IlinkClient } from './client.js';

const POLL_TIMEOUT_MS = 35_000;
const BACKOFF_MAX_S = 30;
const SESSION_EXPIRED_ERRCODE = -14;

const isAbortError = (e: unknown): boolean =>
  !!e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError';

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return reject(err);
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    };
    signal.addEventListener('abort', onAbort);
  });

export interface PollLoopOpts {
  client: IlinkClient;
  initialCursor: string | null;
  signal: AbortSignal;
  onMessage: (raw: unknown) => Promise<void>;
  onCursorUpdate: (cursor: string) => Promise<void>;
  onSessionExpired: () => Promise<void>;
  /** 注入用,测试里给 Promise.resolve() 跳过真实退避等待。 */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export const pollLoop = async (opts: PollLoopOpts): Promise<void> => {
  const sleep = opts.sleep ?? defaultSleep;
  let cursor = opts.initialCursor;
  let consecutiveFailures = 0;

  while (!opts.signal.aborted) {
    try {
      const data = await opts.client.getUpdates(cursor, {
        timeoutMs: POLL_TIMEOUT_MS,
        signal: opts.signal,
      });
      consecutiveFailures = 0;

      if (data.errcode === SESSION_EXPIRED_ERRCODE) {
        await opts.onSessionExpired();
        return;
      }

      const newCursor = data.get_updates_buf ?? '';
      if (newCursor && newCursor !== cursor) {
        cursor = newCursor;
        await opts.onCursorUpdate(newCursor);
      }

      for (const msg of data.msgs ?? []) {
        try {
          await opts.onMessage(msg);
        } catch (e) {
          console.error('[poll-loop] on_message error:', e);
        }
      }
    } catch (e) {
      if (isAbortError(e)) return;
      consecutiveFailures++;
      const backoffMs = Math.min(2 ** consecutiveFailures, BACKOFF_MAX_S) * 1000;
      console.warn('[poll-loop] poll error, backing off', backoffMs, e);
      try {
        await sleep(backoffMs, opts.signal);
      } catch (sleepErr) {
        if (isAbortError(sleepErr)) return;
        throw sleepErr;
      }
    }
  }
};
