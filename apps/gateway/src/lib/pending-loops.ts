/**
 * 进程内 pending loop 上下文缓存 + per-loop SSE 事件流。
 *
 * dispatch 时存入，callback 时取出。避免 callback 路径查 DB 拿 thread/source 信息。
 * 同时管理前端 SSE 订阅：前端发消息后连接 loop SSE，gateway 收到容器心跳/结果时
 * 通过 stream 推送给前端。
 *
 * 进程重启后丢失 — fallback 查 DB (agent_loops + threads 表)。
 */
import Stream from './stream-iterator.js';

// === Loop SSE 事件类型 ===

export type LoopEvent =
  | { type: 'heartbeat' }
  | { type: 'done'; reply: string; completion: 'success' | 'limit' }
  | { type: 'fail'; error: string };

// === PendingLoopContext ===

export interface PendingLoopContext {
  loopId: string;
  threadId: string;
  userId: string;
  source: 'web' | 'wechat';
  lastHeartbeatAt: number;  // Date.now() 时间戳
  /** 前端 SSE 订阅者 */
  streams: Set<Stream<LoopEvent>>;
}

/** 进程内 Map: loopId → context */
export const pendingLoops = new Map<string, PendingLoopContext>();

export const storePendingLoop = (ctx: Omit<PendingLoopContext, 'lastHeartbeatAt' | 'streams'>): void => {
  pendingLoops.set(ctx.loopId, { ...ctx, lastHeartbeatAt: Date.now(), streams: new Set() });
};

export const touchHeartbeat = (loopId: string): boolean => {
  const ctx = pendingLoops.get(loopId);
  if (!ctx) return false;
  ctx.lastHeartbeatAt = Date.now();
  return true;
};

export const consumePendingLoop = (loopId: string): PendingLoopContext | undefined => {
  const ctx = pendingLoops.get(loopId);
  // 不再立即删除 — 等 emitLoopEvent 终态事件时统一清理
  // 这样 emit 时 ctx.streams 还在
  return ctx;
};

/**
 * Reaper 扫描：返回所有 lastHeartbeatAt 超时的 loop id。
 * 调用方负责标 fail + 删除。
 */
export const getStaleLoopIds = (timeoutMs: number): string[] => {
  const cutoff = Date.now() - timeoutMs;
  const stale: string[] = [];
  for (const [loopId, ctx] of pendingLoops) {
    if (ctx.lastHeartbeatAt < cutoff) {
      stale.push(loopId);
    }
  }
  return stale;
};

// === Per-loop SSE 订阅 ===

/** 订阅指定 loop 的事件流。若 ctx 已不存在（已完成），返回已关闭的 stream。 */
export function subscribeLoop(loopId: string): Stream<LoopEvent> {
  const stream = new Stream<LoopEvent>();
  const ctx = pendingLoops.get(loopId);
  if (ctx) {
    ctx.streams.add(stream);
  } else {
    // loop 已结束（emitLoopEvent 终态事件已清理），立即关闭
    stream.close();
  }
  return stream;
}

/** 取消订阅并关闭单个 stream */
export function unsubscribeLoop(loopId: string, stream: Stream<LoopEvent>): void {
  stream.close();
  const ctx = pendingLoops.get(loopId);
  if (ctx) ctx.streams.delete(stream);
}

/** 向指定 loop 的所有订阅者推送事件。终态事件推送后自动关闭所有 stream 并从 Map 中删除。 */
export function emitLoopEvent(loopId: string, event: LoopEvent): void {
  const ctx = pendingLoops.get(loopId);
  if (!ctx) return;
  for (const s of ctx.streams) {
    try { s.send(event); } catch { /* stream already closed */ }
  }
  // 终态事件：关闭所有 stream 并从 Map 中清除
  if (event.type === 'done' || event.type === 'fail') {
    for (const s of ctx.streams) { s.close(); }
    ctx.streams.clear();
    pendingLoops.delete(loopId);
  }
}
