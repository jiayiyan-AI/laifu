/**
 * Token service — 容器侧颁 token 的核心。
 *
 * 取连接 → (provider 支持 refresh 且 access token 临近过期) 用 refresh token 续 → 返明文 access token。
 * GitHub (supportsRefresh=false, 不过期) 走直接解密分支, refresh 机制对它休眠。
 * Google / Figma / GitLab 等接入时, refresh 分支即生效, 无需改容器侧。
 */
import { dao } from '../../db/index.js';
import { encryptToken, decryptToken } from './crypto.js';
import { refreshAccessToken } from './flow.js';
import { getProvider, getProviderCreds } from './providers/registry.js';

/** access token 过期前多久就提前刷新 (留网络往返余量)。 */
const REFRESH_SKEW_MS = 60 * 1000;

export interface AccessTokenResult {
  token: string;
  login: string | null;
}

/**
 * 返回某用户某 provider 的明文 access token (按需刷新)。
 * - 无连接 → null (路由回 410, agent 提示去 web 重新绑定)
 * - 解密 / 刷新失败 → throw (路由回 500)
 */
export const getAccessToken = async (
  userId: string,
  providerId: string,
): Promise<AccessTokenResult | null> => {
  const conn = await dao.oauthConnections.getByUserAndProvider(userId, providerId);
  if (!conn) return null;

  const def = getProvider(providerId);
  const expMs = conn.access_token_expires_at ? new Date(conn.access_token_expires_at).getTime() : null;
  const needsRefresh =
    def?.supportsRefresh === true &&
    !!conn.encrypted_refresh_token &&
    expMs !== null &&
    expMs - Date.now() < REFRESH_SKEW_MS;

  if (needsRefresh && def) {
    const refreshed = await refreshAccessToken(
      def,
      getProviderCreds(providerId),
      decryptToken(conn.encrypted_refresh_token!),
    );
    await dao.oauthConnections.updateTokens({
      userId,
      provider: providerId,
      encryptedAccessToken: encryptToken(refreshed.accessToken),
      // provider 没回新 refresh token 时, 沿用旧的 (don't clobber)
      encryptedRefreshToken: refreshed.refreshToken
        ? encryptToken(refreshed.refreshToken)
        : conn.encrypted_refresh_token,
      accessTokenExpiresAt: refreshed.expiresAt,
    });
    return { token: refreshed.accessToken, login: conn.external_login };
  }

  return { token: decryptToken(conn.encrypted_access_token), login: conn.external_login };
};
