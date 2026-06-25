/**
 * OAuth provider 定义 — 接新平台的唯一扩展点。
 *
 * 每个 provider 提供一份静态 def (endpoint / scopes / 怎么拉账户身份 / 怎么撤销),
 * 凭证 (clientId/clientSecret/localDevToken) 走 config.oauth.providers[<id>]。
 * 标准 OAuth2 token 端点 (RFC 6749 form-encoded) 由 flow.ts 通用处理, provider
 * 只补差异点。详见 docs/todo/github.md。
 */

/** provider 返回的账户身份 + 该 token 实际授到的 scopes。 */
export interface ProviderAccount {
  /** provider 内稳定账号 id (落 external_account_id, 统一 string)。 */
  externalAccountId: string;
  /** 展示用 handle / email (落 external_login)。 */
  externalLogin: string;
  /** 实际 scopes; 空数组表示 provider 不单独报告 (用 token 响应里的 scope 兜底)。 */
  scopes: string[];
}

/** flow.ts 调 provider 时注入的运行时凭证。 */
export interface ProviderCreds {
  clientId: string;
  clientSecret: string;
}

export interface OAuthProviderDef {
  /** provider id, 与 config.oauth.providers 的 key、路由 :provider 段一致。 */
  id: string;
  /** 展示名 (日志 / 错误信息)。 */
  displayName: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** 申请的 scopes。 */
  scopes: readonly string[];
  /** 是否签发 refresh token / access token 会过期 (GitHub OAuth App = false)。 */
  supportsRefresh: boolean;
  /** authorize URL 额外参数 (e.g. Google 的 access_type=offline & prompt=consent)。 */
  extraAuthorizeParams?: Record<string, string>;
  /** 用 access token 拉账户身份 + 实际 scopes。失败 throw。 */
  fetchAccount(accessToken: string): Promise<ProviderAccount>;
  /** 撤销 token (provider-specific)。无则 disconnect 只清本地 DB。 */
  revoke?(accessToken: string, creds: ProviderCreds): Promise<void>;
}
