/**
 * messages 表 DAO — chat 消息读写。
 * 纯消息记录（无状态机），状态逻辑由 agent-loop-dao 承载。
 */
import type { Db } from '@lingxi/db';
import { schema, genId } from '@lingxi/db';
import { eq, asc } from 'drizzle-orm';
import type { MessageRow } from '@lingxi/shared';

export interface MessageDao {
  insert(msg: {
    id: string;
    thread_id: string;
    role: 'user' | 'assistant';
    content_type?: 'text' | 'json';
    content: unknown;
    source: 'web' | 'wechat';
  }): Promise<void>;
  listByThread(threadId: string): Promise<MessageRow[]>;
}

export const makeMessageDao = (db: Db): MessageDao => {
  const t = schema.messages;
  return {
    async insert(msg) {
      await db.insert(t).values({
        id: msg.id,
        thread_id: msg.thread_id,
        role: msg.role,
        content_type: msg.content_type ?? 'text',
        content: msg.content,
        source: msg.source,
      });
    },

    async listByThread(threadId) {
      const rows = await db.select().from(t)
        .where(eq(t.thread_id, threadId))
        .orderBy(asc(t.created_at));
      return rows.map((r) => ({
        id: r.id,
        thread_id: r.thread_id,
        role: r.role,
        content_type: r.content_type,
        content: r.content,
        source: r.source,
        created_at: r.created_at.toISOString(),
      }));
    },
  };
};
