/**
 * OAuth 2.0 provider 抽象。
 *
 * 一个 provider 实现这三个方法,oauth-router.ts 就能为它接入一条标准的
 * Authorization Code flow,无需为每家 OAuth 平台写专门的路由代码。
 *
 * 加新平台 = 在 providers/ 加一个文件 + 在 index.ts registry 加一行。
 */
export interface OAuthProvider {
  /**
   * 构造让浏览器跳过去的「同意页」URL。Gateway 把 state(CSRF token)和
   * redirectUri(回调地址)塞进 query。
   */
  buildAuthUrl(state: string, redirectUri: string): string;

  /**
   * 拿 provider 回调时给的 code,跟 provider 换 access_token。
   * 失败应 throw —— 由 router 决定回什么 HTTP 状态码。
   */
  exchangeCode(code: string, redirectUri: string): Promise<{ access_token: string }>;

  /**
   * 用 access_token 取该用户在 provider 内的稳定身份与基本资料。
   * 返回的 external_id 是 provider 内唯一(Google: `sub`,GitHub: `id`),
   * 用作 oauth_identities 表的 external_id 列。
   */
  fetchUserinfo(accessToken: string): Promise<NormalizedUser>;
}

/**
 * 各家 provider 返回的资料字段五花八门,归一化为这个形状。
 * `email/name/avatar_url` 可能缺失(GitHub/Apple 在某些 scope 下不给)。
 */
export interface NormalizedUser {
  external_id: string;
  email: string | null;
  name: string | null;
  avatar_url: string | null;
}
