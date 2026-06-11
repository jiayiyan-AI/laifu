/**
 * wechat_bindings 表的类型化 DAO (Drizzle 直连版)。
 *
 * 集中所有 SQL 在这,PollManager / 路由 / handleInbound 都用这个 interface,
 * 不直接拼查询 — 便于以后换 ORM/拆 schema/加缓存。
 */
import type { Db } from '@lingxi/db';
import { schema } from '@lingxi/db';
import { eq } from 'drizzle-orm';

export interface WechatBinding {
  id: string;
  user_id: string;
  ilink_bot_id: string;
  bot_token: string;
  base_url: string;
  updates_cursor: string | null;
  is_active: boolean;
  thread_id: string | null;
  bound_at: string;
}

export interface WechatBindingDao {
  /** PollManager.startAll 用: 拉所有活跃绑定。 */
  listActive(): Promise<WechatBinding[]>;

  /** 当前用户的绑定 (含 inactive); GET /api/wechat/bind 用。 */
  getByUserId(userId: string): Promise<WechatBinding | null>;

  /** 扫码 confirmed 时: 新建或换绑(同 user_id 直接 update)。 */
  upsertByUserId(args: {
    user_id: string;
    ilink_bot_id: string;
    bot_token: string;
    base_url: string;
  }): Promise<WechatBinding>;

  /** 长轮询游标推进。 */
  updateCursor(id: string, cursor: string): Promise<void>;

  /** 1 用户 1 thread 写回 binding 的 thread_id。 */
  bindThread(id: string, threadId: string): Promise<void>;

  /** 解绑 / session_expired: 软删,留行作历史。 */
  deactivate(id: string): Promise<void>;
}

interface UpsertArgs {
  user_id: string;
  ilink_bot_id: string;
  bot_token: string;
  base_url: string;
}

const toBinding = (r: typeof schema.wechatBindings.$inferSelect): WechatBinding => ({
  id: r.id,
  user_id: r.user_id,
  ilink_bot_id: r.ilink_bot_id,
  bot_token: r.bot_token,
  base_url: r.base_url,
  updates_cursor: r.updates_cursor,
  is_active: r.is_active,
  thread_id: r.thread_id,
  bound_at: r.bound_at.toISOString(),
});

export const makeWechatBindingDao = (db: Db): WechatBindingDao => {
  const t = schema.wechatBindings;
  return {
    async listActive() {
      const rows = await db.select().from(t).where(eq(t.is_active, true));
      return rows.map(toBinding);
    },

    async getByUserId(userId) {
      const rows = await db.select().from(t).where(eq(t.user_id, userId)).limit(1);
      return rows[0] ? toBinding(rows[0]) : null;
    },

    async upsertByUserId(args: UpsertArgs) {
      const rows = await db.insert(t).values({
        user_id: args.user_id,
        ilink_bot_id: args.ilink_bot_id,
        bot_token: args.bot_token,
        base_url: args.base_url,
        is_active: true,
        updates_cursor: null,
      }).onConflictDoUpdate({
        target: t.user_id,
        set: {
          ilink_bot_id: args.ilink_bot_id,
          bot_token: args.bot_token,
          base_url: args.base_url,
          is_active: true,
          updates_cursor: null,
          bound_at: new Date(),
        },
      }).returning();
      if (!rows[0]) throw new Error('upsertByUserId: returning() empty');
      return toBinding(rows[0]);
    },

    async updateCursor(id, cursor) {
      await db.update(t).set({ updates_cursor: cursor }).where(eq(t.id, id));
    },

    async bindThread(id, threadId) {
      await db.update(t).set({ thread_id: threadId }).where(eq(t.id, id));
    },

    async deactivate(id) {
      await db.update(t).set({ is_active: false }).where(eq(t.id, id));
    },
  };
};
