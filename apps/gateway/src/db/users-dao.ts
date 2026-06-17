/**
 * users 表 DAO — 集中 user upsert / lookup。
 * 消费方: auth/oauth-router.ts, auth/session-routes.ts
 */
import type { Db } from '@lingxi/db';
import { schema } from '@lingxi/db';
import { eq, and } from 'drizzle-orm';

export interface UserRow {
  id: string;
  provider: string;
  external_id: string;
  email: string | null;
  nickname: string | null;
  avatar_url: string | null;
}

export interface UsersDao {
  getById(userId: string): Promise<UserRow | null>;
  getTokenVersion(userId: string): Promise<number | null>;
  upsertByProvider(provider: string, user: {
    external_id: string;
    email: string | null;
    name: string | null;
    avatar_url: string | null;
  }): Promise<{ id: string } | null>;
  createPasswordUser(input: {
    email: string;
    nickname: string;
    hash: string;
  }): Promise<{ id: string } | null>;
  getPasswordUserByEmail(email: string): Promise<(UserRow & { password_hash: string | null }) | null>;
}

export const makeUsersDao = (db: Db): UsersDao => {
  const u = schema.users;
  return {
    async getById(userId) {
      const rows = await db.select({
        id: u.id,
        provider: u.provider,
        external_id: u.external_id,
        email: u.email,
        nickname: u.nickname,
        avatar_url: u.avatar_url,
      }).from(u).where(eq(u.id, userId)).limit(1);
      return rows[0] ?? null;
    },

    async getTokenVersion(userId) {
      const rows = await db.select({ token_version: u.token_version })
        .from(u).where(eq(u.id, userId)).limit(1);
      return rows[0]?.token_version ?? null;
    },

    async upsertByProvider(provider, user) {
      const rows = await db.insert(u).values({
        provider,
        external_id: user.external_id,
        email: user.email,
        nickname: user.name,
        avatar_url: user.avatar_url,
      }).onConflictDoUpdate({
        target: [u.provider, u.external_id],
        set: {
          email: user.email,
          nickname: user.name,
          avatar_url: user.avatar_url,
        },
      }).returning({ id: u.id });
      return rows[0] ?? null;
    },

    async createPasswordUser({ email, nickname, hash }) {
      const rows = await db.insert(u).values({
        provider: 'password',
        // external_id 是小写化的查找键(复用 provider+external_id 唯一索引);
        // email 列保留用户输入的原始大小写用于展示。全局唯一性由 lower(email) 索引保证。
        external_id: email.toLowerCase(),
        email,
        nickname,
        password_hash: hash,
      }).onConflictDoNothing().returning({ id: u.id });
      return rows[0] ?? null;  // null = 邮箱已存在
    },

    async getPasswordUserByEmail(email) {
      const rows = await db.select({
        id: u.id,
        provider: u.provider,
        external_id: u.external_id,
        email: u.email,
        nickname: u.nickname,
        avatar_url: u.avatar_url,
        password_hash: u.password_hash,
      }).from(u)
        .where(and(eq(u.provider, 'password'), eq(u.external_id, email.toLowerCase())))
        .limit(1);
      return rows[0] ?? null;
    },
  };
};
