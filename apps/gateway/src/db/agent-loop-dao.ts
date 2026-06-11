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
  /** 标记循环完成。返回 false 表示已完成（幂等）。 */
  complete(loopId: string, completion: 'success' | 'fail' | 'limit'): Promise<boolean>;
  getById(loopId: string): Promise<AgentLoopRow | null>;
  /** 第一个未完成的循环 */
  getActive(threadId: string): Promise<AgentLoopRow | null>;
  /** 超时未完成的循环标 fail（基于 coalesce(iterated_at, created_at)），返回影响行数 */
  reapStale(olderThanMs: number): Promise<number>;
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

    async reapStale(olderThanMs) {
      const cutoff = new Date(Date.now() - olderThanMs);
      // 基于 coalesce(iterated_at, created_at) — 有心跳用心跳时间，无心跳用创建时间
      const result = await db.update(t)
        .set({ completed_at: new Date(), completion: 'fail' })
        .where(and(
          isNull(t.completed_at),
          sql`coalesce(${t.iterated_at}, ${t.created_at}) < ${cutoff}`,
        ));
      return result.rowCount ?? 0;
    },
  };
};
