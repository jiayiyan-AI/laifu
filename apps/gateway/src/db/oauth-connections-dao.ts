/**
 * user_oauth_connections 表的类型化 DAO (Drizzle 直连版)。
 *
 * 一张表统管所有 OAuth provider (GitHub / GitLab / Figma / Google …)。
 * 每用户每 provider 最多 1 条, 按 (user_id, provider) 唯一。encrypted_* 存的是
 * AES-256-GCM 密文 base64, 加解密由 integrations/oauth/crypto.ts 负责, DAO 只搬密文。
 *
 * 详见 packages/db/src/schema.ts 注释 + docs/todo/github.md §五。
 */
import type { Db } from '@lingxi/db';
import { schema } from '@lingxi/db';
import { and, eq } from 'drizzle-orm';

export interface OauthConnection {
  id: string;
  user_id: string;
  provider: string;
  external_account_id: string;
  external_login: string | null;
  encrypted_access_token: string;
  encrypted_refresh_token: string | null;
  access_token_expires_at: string | null;
  token_scopes: string[];
  metadata: Record<string, unknown> | null;
  connected_at: string;
  last_used_at: string | null;
}

export interface UpsertOauthConnectionArgs {
  userId: string;
  provider: string;
  externalAccountId: string;
  externalLogin: string | null;
  encryptedAccessToken: string;
  encryptedRefreshToken?: string | null;
  accessTokenExpiresAt?: Date | null;
  tokenScopes: string[];
  metadata?: Record<string, unknown> | null;
}

export interface UpdateTokensArgs {
  userId: string;
  provider: string;
  encryptedAccessToken: string;
  encryptedRefreshToken?: string | null;
  accessTokenExpiresAt?: Date | null;
}

export interface OauthConnectionsDao {
  /** 当前用户在某 provider 的绑定; 前端展示 / 颁 token 都查这个。 */
  getByUserAndProvider(userId: string, provider: string): Promise<OauthConnection | null>;

  /** 按 provider + 外部账号 id 查; callback 里检查是否已绑到别的灵犀用户 (409)。 */
  getByProviderAccount(provider: string, externalAccountId: string): Promise<OauthConnection | null>;

  /** 绑定 / 换绑: 同 (user_id, provider) 直接 onConflictDoUpdate, token 覆盖。 */
  upsertByUserAndProvider(args: UpsertOauthConnectionArgs): Promise<OauthConnection>;

  /** token-service 刷新后回写新 access/refresh token + 过期时间。 */
  updateTokens(args: UpdateTokensArgs): Promise<void>;

  /** 每次颁 token 命中更新 last_used_at (best-effort, 不阻塞主流程)。 */
  touchLastUsed(userId: string, provider: string): Promise<void>;

  /** 解绑: 硬删该行 (OAuth grant 由 provider revoke 单独撤)。 */
  deleteByUserAndProvider(userId: string, provider: string): Promise<void>;
}

const toConnection = (
  r: typeof schema.userOauthConnections.$inferSelect,
): OauthConnection => ({
  id: r.id,
  user_id: r.user_id,
  provider: r.provider,
  external_account_id: r.external_account_id,
  external_login: r.external_login,
  encrypted_access_token: r.encrypted_access_token,
  encrypted_refresh_token: r.encrypted_refresh_token,
  access_token_expires_at: r.access_token_expires_at ? r.access_token_expires_at.toISOString() : null,
  token_scopes: r.token_scopes,
  metadata: (r.metadata as Record<string, unknown> | null) ?? null,
  connected_at: r.connected_at.toISOString(),
  last_used_at: r.last_used_at ? r.last_used_at.toISOString() : null,
});

export const makeOauthConnectionsDao = (db: Db): OauthConnectionsDao => {
  const t = schema.userOauthConnections;
  return {
    async getByUserAndProvider(userId, provider) {
      const rows = await db.select().from(t)
        .where(and(eq(t.user_id, userId), eq(t.provider, provider))).limit(1);
      return rows[0] ? toConnection(rows[0]) : null;
    },

    async getByProviderAccount(provider, externalAccountId) {
      const rows = await db.select().from(t)
        .where(and(eq(t.provider, provider), eq(t.external_account_id, externalAccountId))).limit(1);
      return rows[0] ? toConnection(rows[0]) : null;
    },

    async upsertByUserAndProvider(args) {
      const rows = await db.insert(t).values({
        user_id: args.userId,
        provider: args.provider,
        external_account_id: args.externalAccountId,
        external_login: args.externalLogin,
        encrypted_access_token: args.encryptedAccessToken,
        encrypted_refresh_token: args.encryptedRefreshToken ?? null,
        access_token_expires_at: args.accessTokenExpiresAt ?? null,
        token_scopes: args.tokenScopes,
        metadata: args.metadata ?? null,
      }).onConflictDoUpdate({
        target: [t.user_id, t.provider],
        set: {
          external_account_id: args.externalAccountId,
          external_login: args.externalLogin,
          encrypted_access_token: args.encryptedAccessToken,
          encrypted_refresh_token: args.encryptedRefreshToken ?? null,
          access_token_expires_at: args.accessTokenExpiresAt ?? null,
          token_scopes: args.tokenScopes,
          // metadata 仅在显式传入时覆盖; 重连不传则保留旧值 (不抹 installation_id/team_id 等)
          ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
          connected_at: new Date(),
          last_used_at: null,
        },
      }).returning();
      if (!rows[0]) throw new Error('upsertByUserAndProvider: returning() empty');
      return toConnection(rows[0]);
    },

    async updateTokens(args) {
      await db.update(t).set({
        encrypted_access_token: args.encryptedAccessToken,
        encrypted_refresh_token: args.encryptedRefreshToken ?? null,
        access_token_expires_at: args.accessTokenExpiresAt ?? null,
      }).where(and(eq(t.user_id, args.userId), eq(t.provider, args.provider)));
    },

    async touchLastUsed(userId, provider) {
      await db.update(t).set({ last_used_at: new Date() })
        .where(and(eq(t.user_id, userId), eq(t.provider, provider)));
    },

    async deleteByUserAndProvider(userId, provider) {
      await db.delete(t).where(and(eq(t.user_id, userId), eq(t.provider, provider)));
    },
  };
};
