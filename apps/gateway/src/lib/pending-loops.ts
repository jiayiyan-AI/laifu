/**
 * Per-loop 进程内状态: 业务上下文 + SSE 订阅集合 + hard deadline timer。
 *
 * 生命周期:
 *   storePendingLoop  ─ dispatch 后入库 + 启 timer
 *   touchHeartbeat    ─ 容器心跳到达 → 重排 timer (故意不写 DB, 避免和 result
 *                       callback 抢 iterated_at latch)
 *   emitLoopEvent     ─ 终态 (done/fail) 推 SSE + 关 stream + 清 timer + 删 entry
 *
 * 进程重启全丢: callback 路径 fallback 查 DB; boot 时 dao.agentLoops.failOrphans()
 * 一次性扫尾上次崩溃丢的 in-flight loop。
 *
 * 实现: 单 entry 的状态机封装到 `PendingLoop` class (timer / streams / 终态自清理
 * 都内聚在 class 里), 模块级函数作 facade —— 调用方拿到的还是一组无状态 API。
 */
import Stream from './stream-iterator.js';

/**
 * 单个 loop 的硬超时上限 (10 分钟)。
 *
 * 容器侧 HEARTBEAT_INTERVAL = 120s, 留 5 倍空间吸收网络抖动 / 容器卡顿,
 * 又不让真死掉的 loop 挂太久不上报。
 */
export const HARD_DEADLINE_MS = 10 * 60 * 1000;

// ─── Public types ───

export type LoopEvent =
  | { type: 'heartbeat' }
  | { type: 'done'; reply: string; completion: 'success' | 'limit' }
  | { type: 'fail'; error: string };

/** 业务上下文 — callback 路径用来跳过 DB 查 thread/source。 */
export interface PendingLoopContext {
  loopId: string;
  threadId: string;
  userId: string;
  source: 'web' | 'wechat';
}

export interface StorePendingLoopOpts {
  hardDeadlineMs: number;
  /** Hard deadline fire 时调用 (标 fail + 推 SSE)。心跳路径会 reset 这个 timer。 */
  onDeadline: () => void | Promise<void>;
}

// ─── Internal entry ───

/**
 * 单个 pending loop 的进程内状态机。模块外不可见 —— 外界只能通过下面的 facade 函数接触。
 *
 * 是 capability bag: 只暴露 subscribe / unsubscribe / emit / rearm / dispose,
 * 不感知 "事件是不是终态" —— 该判断留在 facade (emitLoopEvent), 由 registry 决定何时
 * dispose + 从 Map 删自己。
 */
class PendingLoop {
  readonly ctx: PendingLoopContext;
  private readonly streams = new Set<Stream<LoopEvent>>();
  private readonly hardDeadlineMs: number;
  private readonly onDeadline: () => void | Promise<void>;
  private timer: NodeJS.Timeout | undefined;

  constructor(ctx: PendingLoopContext, opts: StorePendingLoopOpts) {
    this.ctx = ctx;
    this.hardDeadlineMs = opts.hardDeadlineMs;
    this.onDeadline = opts.onDeadline;
    this.rearm();
  }

  /** 心跳 / 构造时调用 —— 重排 deadline timer。 */
  rearm = (): void => {
    this.cancelTimer();
    this.timer = setTimeout(this.fireDeadline, this.hardDeadlineMs);
  };

  private cancelTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  // setTimeout callback 抛 unhandled rejection 会拖垮进程。
  // onDeadline 自己负责日志, 这里只兜底吞掉。
  private fireDeadline = (): void => {
    Promise.resolve(this.onDeadline()).catch(() => { /* swallowed; see comment above */ });
  };

  subscribe(): Stream<LoopEvent> {
    const stream = new Stream<LoopEvent>();
    this.streams.add(stream);
    return stream;
  }

  unsubscribe(stream: Stream<LoopEvent>): void {
    stream.close();
    this.streams.delete(stream);
  }

  emit(event: LoopEvent): void {
    for (const s of this.streams) {
      try { s.send(event); } catch { /* stream already closed */ }
    }
  }

  /** 关闭所有 stream + 清 timer。registry 终态 / 测试 reset / 重复 store 都用它。 */
  dispose(): void {
    this.cancelTimer();
    for (const s of this.streams) s.close();
    this.streams.clear();
  }
}

// ─── Registry ───

const loops = new Map<string, PendingLoop>();

// ─── Public API (facade) ───

export const storePendingLoop = (ctx: PendingLoopContext, opts: StorePendingLoopOpts): void => {
  // 同一 loopId 重复 store (理论上不应发生; 防御性收掉旧 timer + streams 避免泄漏)。
  loops.get(ctx.loopId)?.dispose();
  loops.set(ctx.loopId, new PendingLoop(ctx, opts));
};

/**
 * 容器心跳 → 重排 deadline timer。
 * 返回 false 表示 entry 不存在 (loop 已终态 / 进程刚重启没缓存), 调用方可忽略。
 */
export const touchHeartbeat = (loopId: string): boolean => {
  const entry = loops.get(loopId);
  if (!entry) return false;
  entry.rearm();
  return true;
};

/**
 * 取业务 ctx。不立即删 entry —— 等 emitLoopEvent 终态时统一清理
 * (届时 SSE streams 还在能推最后一条事件)。
 */
export const consumePendingLoop = (loopId: string): PendingLoopContext | undefined => {
  return loops.get(loopId)?.ctx;
};

/** 若 entry 已不存在 (loop 已终态), 返回已关闭的 stream。 */
export const subscribeLoop = (loopId: string): Stream<LoopEvent> => {
  const entry = loops.get(loopId);
  if (!entry) {
    const closed = new Stream<LoopEvent>();
    closed.close();
    return closed;
  }
  return entry.subscribe();
};

export const unsubscribeLoop = (loopId: string, stream: Stream<LoopEvent>): void => {
  loops.get(loopId)?.unsubscribe(stream);
};

/**
 * 等到某 loop 出终态 (done/fail)。复用 per-loop SSE 订阅做完成信号:
 * 订阅时 loop 已终态 → subscribeLoop 返回已关闭 stream → for-await 立即结束 → 立即 resolve。
 * deadline 兜底也会 emitLoopEvent('fail') 关流, 故绝不会永久挂起。
 * 串行车道 (占道直到 loop 完成) 与 web/聚合 的 in-flight 释放都复用它。
 */
export const waitLoopTerminal = async (loopId: string): Promise<void> => {
  const stream = subscribeLoop(loopId);
  try {
    for await (const ev of stream) {
      if (ev.type === 'done' || ev.type === 'fail') return;
    }
  } finally {
    unsubscribeLoop(loopId, stream);
  }
};

/**
 * 向指定 loop 的所有订阅者推送事件。终态 (done/fail) 由 registry 在这里 dispose + 删 entry。
 */
export const emitLoopEvent = (loopId: string, event: LoopEvent): void => {
  const entry = loops.get(loopId);
  if (!entry) return;
  entry.emit(event);
  if (event.type === 'done' || event.type === 'fail') {
    entry.dispose();
    loops.delete(loopId);
  }
};

// ─── Introspection / test utilities ───

/** 进程内是否还跟着这个 loop。callback 路径 / 测试都可用。 */
export const hasPendingLoop = (loopId: string): boolean => loops.has(loopId);

/**
 * 测试 reset 用。生产代码不要调 —— 会直接抛掉所有 in-flight loop 的 timer 和 SSE 订阅。
 */
export const __resetPendingLoopsForTests = (): void => {
  for (const e of loops.values()) e.dispose();
  loops.clear();
};
