import type { Db } from '@lingxi/db';
import { schema } from '@lingxi/db';
import { eq, and, isNull, sql } from 'drizzle-orm';

export interface EntitlementsDao {
  /** 列出 user 当前 active 的 features (disabled_at IS NULL). */
  listActive(userId: string): Promise<string[]>;

  /** 启用 (或重新启用) 某 feature；返回是否真发生了状态变更. */
  enable(userId: string, feature: string): Promise<{ changed: boolean }>;

  /** 停用某 feature (disabled_at = now)；返回是否真发生了状态变更. */
  disable(userId: string, feature: string): Promise<{ changed: boolean }>;

  /** 拿 users.token_version. user 不存在返回 null. */
  getTokenVersion(userId: string): Promise<number | null>;

  /** 原子递增 token_version, 返回新值. */
  bumpTokenVersion(userId: string): Promise<number>;
}

export const makeEntitlementsDao = (db: Db): EntitlementsDao => {
  const t = schema.userEntitlements;
  const u = schema.users;

  return {
    async listActive(userId) {
      const rows = await db.select({ feature: t.feature })
        .from(t)
        .where(and(eq(t.user_id, userId), isNull(t.disabled_at)));
      return rows.map((r) => r.feature);
    },

    async enable(userId, feature) {
      // 先查当前状态判断是否 changed
      const existing = await db.select({ disabled_at: t.disabled_at })
        .from(t)
        .where(and(eq(t.user_id, userId), eq(t.feature, feature)))
        .limit(1);

      const wasActive = existing[0] && existing[0].disabled_at === null;

      await db.insert(t).values({
        user_id: userId,
        feature,
        enabled_at: new Date(),
        disabled_at: null,
      }).onConflictDoUpdate({
        target: [t.user_id, t.feature],
        set: {
          enabled_at: new Date(),
          disabled_at: null,
        },
      });

      return { changed: !wasActive };
    },

    async disable(userId, feature) {
      const rows = await db.update(t)
        .set({ disabled_at: new Date() })
        .where(and(eq(t.user_id, userId), eq(t.feature, feature), isNull(t.disabled_at)))
        .returning();
      return { changed: rows.length > 0 };
    },

    async getTokenVersion(userId) {
      const rows = await db.select({ token_version: u.token_version })
        .from(u)
        .where(eq(u.id, userId))
        .limit(1);
      return rows[0]?.token_version ?? null;
    },

    async bumpTokenVersion(userId) {
      const [row] = await db.update(u)
        .set({ token_version: sql`${u.token_version} + 1` })
        .where(eq(u.id, userId))
        .returning({ token_version: u.token_version });
      if (!row) throw new Error(`bumpTokenVersion: user ${userId} not found`);
      return row.token_version;
    },
  };
};
