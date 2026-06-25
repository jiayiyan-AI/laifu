/**
 * GitHub OAuth App provider def。MVP 唯一接入的 provider。
 *
 * 特性: token 长期有效、无 refresh (supportsRefresh=false)。
 * 账户身份取 GET /user; 实际 scopes 取 X-OAuth-Scopes 响应头 (比 token 响应的 scope 字段权威)。
 * 撤销走 DELETE /applications/{client_id}/token (撤 token 不撤 grant, 重连免再过 consent 页)。
 * 详见 docs/todo/github.md §三/§四.C/§七.1。
 */
import type { OAuthProviderDef, ProviderAccount, ProviderCreds } from './types.js';

const API = 'https://api.github.com';

const parseScopeList = (raw: string): string[] =>
  raw.split(',').map((s) => s.trim()).filter(Boolean);

export const githubProvider: OAuthProviderDef = {
  id: 'github',
  displayName: 'GitHub',
  authorizeUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  // 覆盖 AI 操作仓库的常见场景: repo(全仓库读写, 含 PR/issue/CI 状态) + workflow(push 改动
  // .github/workflows/* 必需, 否则 git push 被 GitHub 拒) + read:org(读 org/team 元数据, gh repo
  // list <org> 等) + gist(创建/编辑 gist) + read:user(回填 login/id/email)。
  // 故意不含 delete_repo: 删库是灾难操作, 系统提示也禁止 (docs/todo/github.md §六.10/§八), 最小权限排除。
  scopes: ['repo', 'workflow', 'read:org', 'gist', 'read:user'],
  supportsRefresh: false,

  async fetchAccount(accessToken: string): Promise<ProviderAccount> {
    const resp = await fetch(`${API}/user`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'lingxi-gateway',
      },
    });
    if (!resp.ok) {
      throw new Error(`GitHub /user failed (${resp.status})`);
    }
    const u = await resp.json() as { id?: number; login?: string };
    if (typeof u.id !== 'number' || typeof u.login !== 'string') {
      throw new Error('GitHub /user: missing id or login');
    }
    return {
      externalAccountId: String(u.id),
      externalLogin: u.login,
      scopes: parseScopeList(resp.headers.get('x-oauth-scopes') ?? ''),
    };
  },

  /** 204 (成功) / 404 / 422 (token 已失效) 都算成功; 其它状态 throw。 */
  async revoke(accessToken: string, creds: ProviderCreds): Promise<void> {
    const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
    const resp = await fetch(`${API}/applications/${creds.clientId}/token`, {
      method: 'DELETE',
      headers: {
        Authorization: `Basic ${basic}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'lingxi-gateway',
      },
      body: JSON.stringify({ access_token: accessToken }),
    });
    if (resp.status !== 204 && resp.status !== 404 && resp.status !== 422) {
      const text = await resp.text().catch(() => '');
      throw new Error(`GitHub token revoke failed (${resp.status}): ${text.slice(0, 200)}`);
    }
  },
};
