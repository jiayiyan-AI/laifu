/**
 * Per-thread 串行车道 —— 保证「同一个 thread 在同一时刻只有一个 hermes /chat 调用在跑」。
 *
 * 背景:微信图文混排会被 iLink 拆成两条独立入站消息(图一条、文字一条,顺序不保证),
 * gateway 各起一个 agent loop → 同一 session 上两轮 agent 并发跑 → DB(messages/agent_loops)
 * 与容器 hermes session state.db 紊乱、两条互不关联的回复。本模块把同一 threadId 的派发任务
 * 排进一条串行车道:前一轮 loop **真正完成**(done/fail/deadline 终态)之前,后到的消息在
 * gateway 这一层排队等待,轮到了才派发。
 *
 * 关键点:
 *  - 车道粒度 = threadId(== sessionId `${source}:${threadId}`,thread.source 固定故一一对应)。
 *  - 「完成」信号复用 per-loop SSE 订阅(subscribeLoop):loop 终态 emitLoopEvent(done/fail)
 *    或 hard deadline 都会推一条终态事件并关流 → waitLoopTerminal 解除占用。deadline(10min)
 *    是兜底,保证车道不会因丢回调而永久卡死。
 *  - **fire-and-forget**:enqueueThreadTask 同步返回是否接纳,调用方(poll loop 的 onMessage)
 *    绝不 await 任务完成,否则会卡住整条长轮询、停止拉取新消息。
 *  - 进程内状态,进程重启即丢(与 pending-loops 同philosophy;DB 侧由 failOrphans 扫尾)。
 */
import { waitLoopTerminal } from './pending-loops.js';
import { log } from './logger.js';

/** 单条车道最多排多少任务(含在跑的那个)。超出则拒绝,调用方给用户「稍后再发」提示。 */
export const MAX_QUEUE_PER_THREAD = 8;

interface ThreadLane {
  /** 链尾:最后一个入队任务**完整结算**(派发 + 占用直到 loop 终态)后 resolve。 */
  tail: Promise<void>;
  /** 排队 + 在跑的任务总数,用于限流与车道回收。 */
  depth: number;
  /** 仅供测试:最后一个任务的「派发阶段」完成信号(早于占用阶段)。 */
  lastDispatched: Promise<void>;
}

const lanes = new Map<string, ThreadLane>();

/**
 * 把 task 排进 threadId 的串行车道。
 *  - task 返回 loopId → 占住车道直到该 loop 终态(下一任务此前不会派发);
 *  - task 返回 null → 没起 hermes 调用(配额/容器未就绪/全图失败/派发失败等),立即释放。
 * 同步返回是否接纳(车道已满 → false)。**fire-and-forget**:不要 await 返回后的任何东西。
 */
export const enqueueThreadTask = (
  threadId: string,
  task: () => Promise<string | null>,
): boolean => {
  const lane = lanes.get(threadId);
  const depth = lane?.depth ?? 0;
  if (depth >= MAX_QUEUE_PER_THREAD) return false;

  const prev = lane?.tail ?? Promise.resolve();

  const { promise: dispatched, resolve: markDispatched } = Promise.withResolvers<void>();

  const run: Promise<void> = prev
    .then(async () => {
      let loopId: string | null = null;
      try {
        loopId = await task();
      } finally {
        markDispatched();
      }
      if (loopId) await waitLoopTerminal(loopId);
    })
    .catch((e: unknown) => {
      log.warn({
        event: 'thread.serial.task.error',
        thread_id: threadId,
        err: e instanceof Error ? e.message : String(e),
      });
    })
    .finally(() => {
      const cur = lanes.get(threadId);
      if (!cur) return;
      cur.depth -= 1;
      // 只有当自己就是链尾且无后继时才回收车道,避免删掉有 pending 任务的 lane。
      if (cur.depth <= 0 && cur.tail === run) lanes.delete(threadId);
    });

  lanes.set(threadId, { tail: run, depth: depth + 1, lastDispatched: dispatched });
  return true;
};

/** 当前车道上排队 + 在跑的任务数(0 = 空闲)。 */
export const threadQueueDepth = (threadId: string): number => lanes.get(threadId)?.depth ?? 0;

// ─── 测试工具(生产代码勿用)───

/** 等到当前所有车道的「派发阶段」结算 —— 测试里断言派发副作用前调用。 */
export const __whenDispatchedForTests = async (): Promise<void> => {
  await Promise.all([...lanes.values()].map((l) => l.lastDispatched));
};

/** 清空所有车道(放弃仍在占用的任务)。afterEach 用。 */
export const __resetThreadSerializerForTests = (): void => {
  lanes.clear();
};
