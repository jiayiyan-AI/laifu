/**
 * threads 表 DAO — 集中所有 thread CRUD。
 * 消费方: api/threads.ts, wechat-ilink/inbound-handler.ts
 */
import type { Db } from '@lingxi/db';
import { schema, genId } from '@lingxi/db';
import { eq, and, desc } from 'drizzle-orm';
import type { Thread, MessageSource } from '@lingxi/shared';

export interface ThreadsDao {
  create(row: { id: string; user_id: string; source: string; title: string | null }): Promise<Thread>;
  listByUser(userId: string): Promise<Pick<Thread, 'id' | 'title' | 'updated_at' | 'archived'>[]>;
  getByIdAndUser(id: string, userId: string): Promise<Thread | null>;
  /**
   * 硬删 thread (FK ON DELETE CASCADE 自动带走 messages / agent_loops / tool_calls)。
   * 返回 true = 命中并删除; false = 没找到 (id 不存在 或 不属于 userId)。
   */
  deleteById(id: string, userId: string): Promise<boolean>;
}

const toThread = (r: typeof schema.threads.$inferSelect): Thread => ({
  id: r.id,
  user_id: r.user_id,
  source: r.source as MessageSource,
  title: r.title,
  created_at: r.created_at?.toISOString() ?? new Date().toISOString(),
  updated_at: r.updated_at?.toISOString() ?? new Date().toISOString(),
  archived: r.archived ?? false,
});

export const makeThreadsDao = (db: Db): ThreadsDao => {
  const t = schema.threads;
  return {
    async create(row) {
      await db.insert(t).values({
        id: row.id,
        user_id: row.user_id,
        source: row.source,
        title: row.title,
        archived: false,
      });
      const rows = await db.select().from(t).where(eq(t.id, row.id)).limit(1);
      return toThread(rows[0]!);
    },

    async listByUser(userId) {
      const rows = await db.select({
        id: t.id,
        title: t.title,
        updated_at: t.updated_at,
        archived: t.archived,
      })
        .from(t)
        .where(eq(t.user_id, userId))
        .orderBy(desc(t.updated_at));
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        updated_at: r.updated_at?.toISOString() ?? new Date().toISOString(),
        archived: r.archived ?? false,
      }));
    },

    async getByIdAndUser(id, userId) {
      const rows = await db.select().from(t)
        .where(and(eq(t.id, id), eq(t.user_id, userId)))
        .limit(1);
      return rows[0] ? toThread(rows[0]) : null;
    },

    async deleteById(id, userId) {
      const result = await db.delete(t).where(and(eq(t.id, id), eq(t.user_id, userId)));
      return (result.rowCount ?? 0) > 0;
    },
  };
};
