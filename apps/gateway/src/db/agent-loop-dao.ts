/**
 * agent_loops 表 DAO — Agent 循环执行状态管理。
 * 每次用户发消息触发一轮 agent 推理循环。
 */
import type { Db } from '@lingxi/db';
import { schema } from '@lingxi/db';
import { eq, and, isNull, sql } from 'drizzle-orm';
import type { AgentLoopRow } from '@lingxi/shared';

export interface AgentLoopDao {
  create(params: { id: string; thread_id: string; message_id: string }): Promise<void>;
  /**
   * 标记循环完成 (deadline timer / dispatch 失败用)。返回 false 表示已完成（幂等）。
   * 只判 completed_at,不动 iterated_at —— 让后续晚到的 result callback 仍能赢 latch。
   */
  complete(loopId: string, completion: 'success' | 'fail' | 'limit'): Promise<boolean>;
  /**
   * Result callback 专用幂等 latch。
   *
   * iterated_at 这一列被重新定义为 "result 已落库" 的 sentinel:
   *   - WHERE iterated_at IS NULL 抢锁,赢的那次写消息;
   *   - 即便 deadline timer 已先把 completion 标成 fail (completed_at 已写,iterated_at 仍 NULL),
   *     result callback 也能反转 completion 把 reply 持久化。
   *
   * 返回 true 表示抢到 latch,调用方负责后续写 assistant 消息 / 推 SSE / wechat reply。
   */
  recordResult(loopId: string, completion: 'success' | 'fail' | 'limit'): Promise<boolean>;
  getById(loopId: string): Promise<AgentLoopRow | null>;
  /** 第一个未完成的循环 */
  getActive(threadId: string): Promise<AgentLoopRow | null>;
  /**
   * 启动时一次性扫尾: 把比 olderThanMs 还老、还没完成的 loop 标 fail。
   * 用来收拾上次进程崩溃时丢的 in-flight loop —— 它们的 per-loop deadline timer 随进程一起没了。
   * 返回影响行数。
   */
  failOrphans(olderThanMs: number): Promise<number>;
}

const toRow = (r: typeof schema.agentLoops.$inferSelect): AgentLoopRow => ({
  id: r.id,
  thread_id: r.thread_id,
  message_id: r.message_id,
  completion: r.completion,
  created_at: r.created_at.toISOString(),
  completed_at: r.completed_at?.toISOString() ?? null,
});

export const makeAgentLoopDao = (db: Db): AgentLoopDao => {
  const t = schema.agentLoops;
  return {
    async create(params) {
      await db.insert(t).values({
        id: params.id,
        thread_id: params.thread_id,
        message_id: params.message_id,
      });
    },

    async complete(loopId, completion) {
      const result = await db.update(t)
        .set({ completed_at: new Date(), completion })
        .where(and(eq(t.id, loopId), isNull(t.completed_at)));
      return (result.rowCount ?? 0) > 0;
    },

    async recordResult(loopId, completion) {
      const now = new Date();
      const result = await db.update(t)
        .set({ iterated_at: now, completion, completed_at: now })
        .where(and(eq(t.id, loopId), isNull(t.iterated_at)));
      return (result.rowCount ?? 0) > 0;
    },

    async getById(loopId) {
      const rows = await db.select().from(t).where(eq(t.id, loopId)).limit(1);
      return rows[0] ? toRow(rows[0]) : null;
    },

    async getActive(threadId) {
      const rows = await db.select().from(t)
        .where(and(eq(t.thread_id, threadId), isNull(t.completed_at)))
        .limit(1);
      return rows[0] ? toRow(rows[0]) : null;
    },

    async failOrphans(olderThanMs) {
      const cutoff = new Date(Date.now() - olderThanMs);
      const result = await db.update(t)
        .set({ completed_at: new Date(), completion: 'fail' })
        .where(and(
          isNull(t.completed_at),
          sql`${t.created_at} < ${cutoff}`,
        ));
      return result.rowCount ?? 0;
    },
  };
};
