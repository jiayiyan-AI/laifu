/**
 * Per-thread in-flight 闸 —— web 通道的并发兜底。
 *
 * web `/api/chat` 是同步 request/response,不像 wechat 走 fire-and-forget 串行车道。
 * 前端 `disabled={busy}` 只挡单标签;多标签/多设备/直连 API/reload 竞态下,同一 thread
 * 仍可能并发两个 `/api/chat` → 两轮 agent loop 并发 → DB(messages/agent_loops) 与容器
 * session state.db 紊乱。本模块在服务端做最后一道闸:同 thread 已有 loop 在跑 → 拒(409)。
 *
 * 与 wechat 串行车道正交:thread 单源(thread.source 固定 web/wechat),故 web 线程与
 * wechat 线程集合不相交,两套互不竞争、无需共享状态。
 *
 * 语义是 **reject-not-queue**(不阻塞 HTTP 数分钟):
 *  - `tryReserveThread` 同步 check-and-set,已占用返 false;
 *  - dispatch 成功后挂 `waitLoopTerminal(loopId).then(release)`,loop 终态自动释放;
 *  - dispatch 失败 / deadline 分支也要显式 `releaseThread`。
 *
 * 进程内状态,进程重启即丢(与 pending-loops / thread-serializer 同 philosophy)。
 */

const inflight = new Set<string>();

/** 同步占用 threadId。已被占用 → false(调用方回 409),否则占住并返 true。 */
export const tryReserveThread = (threadId: string): boolean => {
  if (inflight.has(threadId)) return false;
  inflight.add(threadId);
  return true;
};

/** 释放 threadId。幂等。loop 终态 / dispatch 失败 / deadline 都应调一次。 */
export const releaseThread = (threadId: string): void => {
  inflight.delete(threadId);
};

/** 当前 thread 是否被占用(仅供 introspection / 测试)。 */
export const isThreadReserved = (threadId: string): boolean => inflight.has(threadId);

/** 测试 reset 用。生产代码勿调。 */
export const __resetThreadInflightForTests = (): void => {
  inflight.clear();
};
