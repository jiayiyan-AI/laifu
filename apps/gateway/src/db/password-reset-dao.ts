/**
 * password_reset_tokens DAO — 找回密码一次性 token。
 * 过期判断一律用 DB now(), 不信应用侧时钟。
 * 消费方: auth/password-routes.ts
 */
import type { Db } from '@lingxi/db';
import { schema } from '@lingxi/db';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';

export interface PasswordResetDao {
  /** 作废该用户所有未用 token, 再插入新 token(同一事务)。 */
  create(input: { userId: string; tokenHash: string; ttlMinutes: number }): Promise<void>;
  /** 原子消费: 未用且未过期才命中, 返回 user_id; 否则 null。并发下只有一个调用能拿到。 */
  consume(tokenHash: string): Promise<string | null>;
}

export const makePasswordResetDao = (db: Db): PasswordResetDao => {
  const t = schema.passwordResetTokens;
  return {
    async create({ userId, tokenHash, ttlMinutes }) {
      await db.transaction(async (tx) => {
        await tx.update(t).set({ used_at: sql`now()` })
          .where(and(eq(t.user_id, userId), isNull(t.used_at)));
        await tx.insert(t).values({
          token_hash: tokenHash,
          user_id: userId,
          expires_at: sql`now() + make_interval(mins => ${ttlMinutes})`,
        });
      });
    },

    async consume(tokenHash) {
      const rows = await db.update(t).set({ used_at: sql`now()` })
        .where(and(eq(t.token_hash, tokenHash), isNull(t.used_at), gt(t.expires_at, sql`now()`)))
        .returning({ user_id: t.user_id });
      return rows[0]?.user_id ?? null;
    },
  };
};
