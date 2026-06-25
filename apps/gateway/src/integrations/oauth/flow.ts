/**
 * 通用 OAuth2 授权码流 (RFC 6749) — authorize URL / code→token / refresh。
 *
 * 标准 form-encoded token 端点对 GitHub / GitLab / Google / Figma 等都适用;
 * provider 专属差异 (账户身份、实际 scopes、撤销) 收在 providers/<id>.ts 的 def 里。
 */
import type { OAuthProviderDef, ProviderCreds } from './providers/types.js';

export interface TokenExchangeResult {
  accessToken: string;
  refreshToken: string | null;
  /** null = 不过期 (GitHub OAuth App)。 */
  expiresAt: Date | null;
  /** token 响应里报告的 scopes (provider 的 fetchAccount 若给了更权威值, 以那个为准)。 */
  scopes: string[];
}

const parseScopeList = (raw: string): string[] =>
  raw.split(/[ ,]+/).map((s) => s.trim()).filter(Boolean);

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

const toResult = (data: RawTokenResponse): TokenExchangeResult => ({
  accessToken: data.access_token!,
  refreshToken: data.refresh_token ?? null,
  expiresAt: typeof data.expires_in === 'number' ? new Date(Date.now() + data.expires_in * 1000) : null,
  scopes: parseScopeList(data.scope ?? ''),
});

/** 构造让浏览器跳过去的 provider 同意页 URL。 */
export const buildAuthUrl = (
  def: OAuthProviderDef,
  creds: ProviderCreds,
  state: string,
  redirectUri: string,
): string => {
  const params = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: redirectUri,
    scope: def.scopes.join(' '),
    state,
    ...(def.extraAuthorizeParams ?? {}),
  });
  return `${def.authorizeUrl}?${params.toString()}`;
};

const postToken = async (
  def: OAuthProviderDef,
  body: URLSearchParams,
): Promise<TokenExchangeResult> => {
  const resp = await fetch(def.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`${def.displayName} token endpoint failed (${resp.status}): ${text.slice(0, 200)}`);
  }
  const data = await resp.json() as RawTokenResponse;
  if (data.error || !data.access_token) {
    throw new Error(`${def.displayName} token error: ${data.error_description ?? data.error ?? 'missing access_token'}`);
  }
  return toResult(data);
};

/** code → access_token (+ refresh / expiry / scopes)。失败 throw, 由 router 决定状态码。 */
export const exchangeCode = (
  def: OAuthProviderDef,
  creds: ProviderCreds,
  code: string,
  redirectUri: string,
): Promise<TokenExchangeResult> =>
  postToken(def, new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    code,
    redirect_uri: redirectUri,
  }));

/** refresh_token → 新 access_token。仅 supportsRefresh 的 provider 调。 */
export const refreshAccessToken = (
  def: OAuthProviderDef,
  creds: ProviderCreds,
  refreshToken: string,
): Promise<TokenExchangeResult> =>
  postToken(def, new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: refreshToken,
  }));
