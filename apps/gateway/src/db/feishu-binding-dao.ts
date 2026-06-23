/**
 * feishu_bindings 表的类型化 DAO (Drizzle 直连版)。
 *
 * 集中所有 SQL 在这，飞书渠道相关模块都用这个 interface，
 * 不直接拼查询 — 便于以后换 ORM/拆 schema/加缓存。
 *
 * 接口对齐 wechat-binding-dao.ts，字段对应飞书自建应用场景。
 */
import type { Db } from '@lingxi/db';
import { schema } from '@lingxi/db';
import { eq, and } from 'drizzle-orm';

export interface FeishuBinding {
  id: string;
  user_id: string;
  app_id: string;
  app_secret: string;
  domain: string;
  owner_open_id: string;
  thread_id: string | null;
  status: string;
  is_active: boolean;
  bound_at: string;
}

export interface FeishuBindingDao {
  /** 拉所有活跃绑定 (is_active=true)。 */
  listActive(): Promise<FeishuBinding[]>;

  /** 当前用户的绑定 (含 inactive); GET /api/feishu/bind 用。 */
  getByUserId(userId: string): Promise<FeishuBinding | null>;

  /**
   * 用户提交飞书 app 时: 新建或换绑 (同 user_id 直接 onConflictDoUpdate)。
   * status 置 'pending_approval'，is_active true。
   */
  upsertByUserId(args: {
    userId: string;
    appId: string;
    appSecret: string;
    domain: string;
    ownerOpenId: string;
  }): Promise<FeishuBinding>;

  /** 审批通过后: 设置 is_active=true 及自定义 status。 */
  setActive(id: string, status: string): Promise<void>;

  /** 1 用户 1 thread 写回 binding 的 thread_id。 */
  bindThread(id: string, threadId: string): Promise<void>;

  /** 解绑 / 停用: 软删，留行作历史。 */
  deactivate(id: string): Promise<void>;
}

interface UpsertArgs {
  userId: string;
  appId: string;
  appSecret: string;
  domain: string;
  ownerOpenId: string;
}

const toBinding = (r: typeof schema.feishuBindings.$inferSelect): FeishuBinding => ({
  id: r.id,
  user_id: r.user_id,
  app_id: r.app_id,
  app_secret: r.app_secret,
  domain: r.domain,
  owner_open_id: r.owner_open_id,
  thread_id: r.thread_id,
  status: r.status,
  is_active: r.is_active,
  bound_at: r.bound_at.toISOString(),
});

export const makeFeishuBindingDao = (db: Db): FeishuBindingDao => {
  const t = schema.feishuBindings;
  return {
    async listActive() {
      const rows = await db.select().from(t).where(and(eq(t.is_active, true), eq(t.status, 'active')));
      return rows.map(toBinding);
    },

    async getByUserId(userId) {
      const rows = await db.select().from(t).where(eq(t.user_id, userId)).limit(1);
      return rows[0] ? toBinding(rows[0]) : null;
    },

    async upsertByUserId(args: UpsertArgs) {
      const rows = await db.insert(t).values({
        user_id: args.userId,
        app_id: args.appId,
        app_secret: args.appSecret,
        domain: args.domain,
        owner_open_id: args.ownerOpenId,
        status: 'pending_approval',
        is_active: true,
      }).onConflictDoUpdate({
        target: t.user_id,
        set: {
          app_id: args.appId,
          app_secret: args.appSecret,
          domain: args.domain,
          owner_open_id: args.ownerOpenId,
          status: 'pending_approval',
          is_active: true,
          bound_at: new Date(),
        },
      }).returning();
      if (!rows[0]) throw new Error('upsertByUserId: returning() empty');
      return toBinding(rows[0]);
    },

    async setActive(id, status) {
      await db.update(t).set({ is_active: true, status }).where(eq(t.id, id));
    },

    async bindThread(id, threadId) {
      await db.update(t).set({ thread_id: threadId }).where(eq(t.id, id));
    },

    async deactivate(id) {
      await db.update(t).set({ is_active: false }).where(eq(t.id, id));
    },
  };
};
