/**
 * users 表 DAO — 集中 user upsert / lookup。
 * 消费方: auth/oauth-router.ts, auth/session-routes.ts
 */
import type { Db } from '@lingxi/db';
import { schema } from '@lingxi/db';
import { eq, and, sql } from 'drizzle-orm';

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
    hash: string;
  }): Promise<{ id: string } | null>;
  getPasswordUserByEmail(email: string): Promise<(UserRow & { password_hash: string | null; session_version: number }) | null>;
  /** 网页 session 吊销版本号; 用户不存在返回 null。 */
  getSessionVersion(userId: string): Promise<number | null>;
  getPasswordAuthById(userId: string): Promise<{ provider: string; password_hash: string | null } | null>;
  /** 写入新密码 hash 并 session_version+1, 返回新 sv; 用户不存在返回 null。 */
  updatePasswordAndBumpSession(userId: string, hash: string): Promise<number | null>;
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

    async createPasswordUser({ email, hash }) {
      const rows = await db.insert(u).values({
        provider: 'password',
        // external_id 是小写化的查找键(复用 provider+external_id 唯一索引);
        // email 列保留用户输入的原始大小写用于展示。全局唯一性由 lower(email) 索引保证。
        external_id: email.toLowerCase(),
        email,
        // nickname 不在注册时收集(列可空), 展示处统一 fallback "未命名"。
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
        session_version: u.session_version,
      }).from(u)
        .where(and(eq(u.provider, 'password'), eq(u.external_id, email.toLowerCase())))
        .limit(1);
      return rows[0] ?? null;
    },

    async getSessionVersion(userId) {
      const rows = await db.select({ sv: u.session_version })
        .from(u).where(eq(u.id, userId)).limit(1);
      return rows[0]?.sv ?? null;
    },

    async getPasswordAuthById(userId) {
      const rows = await db.select({ provider: u.provider, password_hash: u.password_hash })
        .from(u).where(eq(u.id, userId)).limit(1);
      return rows[0] ?? null;
    },

    async updatePasswordAndBumpSession(userId, hash) {
      // 单条 UPDATE: 写 hash 与 sv+1 原子完成, 返回新 sv 供当前设备换发 cookie。
      const rows = await db.update(u)
        .set({ password_hash: hash, session_version: sql`${u.session_version} + 1` })
        .where(eq(u.id, userId))
        .returning({ sv: u.session_version });
      return rows[0]?.sv ?? null;
    },
  };
};
