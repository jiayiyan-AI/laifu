/**
 * OAuth 集成路由 — 一套路由统管所有 provider (docs/todo/github.md §六.1)。
 *
 *   GET    /api/me/oauth/:provider/connect-url        (session)   生成 OAuth URL (或 dev 短路 URL)
 *   GET    /api/integrations/oauth/:provider/callback             OAuth 回调: code → token → 入库
 *   GET    /api/integrations/oauth/:provider/dev-callback (session, 仅 local) dev 短路绑定
 *   GET    /api/me/oauth/:provider/token              (container) 容器侧拉 plaintext token
 *   GET    /api/me/oauth/:provider/connection         (session)   列绑定供前端展示
 *   DELETE /api/me/oauth/:provider/connection         (session)   解绑 (revoke + 清 DB)
 *
 * 不接入 auth/providers/ registry — 那是"登录创建 session", 这里是"给已有 session 加操作权能"。
 * 接新 provider: providers/<id>.ts 加 def + config.oauth.providers 加凭证, 本文件零改动。
 */
import { Router, type Request, type Response, type RequestHandler, type Router as RouterType } from 'express';
import { randomBytes } from 'node:crypto';
import { dao } from '../../db/index.js';
import { buildAuthUrl, exchangeCode } from './flow.js';
import { encryptToken, encryptOptional, decryptToken } from './crypto.js';
import { getAccessToken } from './token-service.js';
import {
  getProvider,
  getProviderCreds,
  isKnownProvider,
  isProviderConnectEnabled,
} from './providers/registry.js';
import { devShortcutEnabled, handleDevCallback } from './dev-shortcut.js';

const STATE_COOKIE_PREFIX = 'lingxi_oauth_state_';
const STATE_TTL_MS = 10 * 60 * 1000;

const stateCookieName = (provider: string) => `${STATE_COOKIE_PREFIX}${provider}`;

const stateCookieOpts = () => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env['NODE_ENV'] === 'production',
  maxAge: STATE_TTL_MS,
  path: '/',
});

// ── per-(user,provider) 限速 (token endpoint): 固定窗口 60 req/min ──
const TOKEN_RATE_LIMIT = 60;
const TOKEN_RATE_WINDOW_MS = 60 * 1000;
const tokenHits = new Map<string, { count: number; windowStart: number }>();

const overTokenRateLimit = (key: string): boolean => {
  const now = Date.now();
  const cur = tokenHits.get(key);
  if (!cur || now - cur.windowStart >= TOKEN_RATE_WINDOW_MS) {
    tokenHits.set(key, { count: 1, windowStart: now });
    return false;
  }
  cur.count += 1;
  return cur.count > TOKEN_RATE_LIMIT;
};

export interface OAuthRouterOpts {
  sessionMw: RequestHandler;
  containerAuth: RequestHandler;
  publicBaseUrl: string;
  frontendBaseUrl: string;
}

const callbackRedirectUri = (publicBaseUrl: string, provider: string): string =>
  `${publicBaseUrl}/api/integrations/oauth/${provider}/callback`;

export const buildOAuthRouter = (opts: OAuthRouterOpts): RouterType => {
  const r = Router();

  // 未知 provider → 404, 已知则 def 一定非空, 后续 handler 不必再判。
  r.param('provider', (_req: Request, res: Response, next, provider: string) => {
    if (!isKnownProvider(provider)) {
      res.status(404).json({ error: `unknown OAuth provider: ${provider}` });
      return;
    }
    next();
  });

  // ── connect-url: 返 OAuth URL (或 dev 短路 URL) 给前端 ──
  r.get('/api/me/oauth/:provider/connect-url', opts.sessionMw, (req: Request, res: Response) => {
    const provider = req.params['provider']!;
    if (devShortcutEnabled(provider)) {
      res.json({ url: `${opts.publicBaseUrl}/api/integrations/oauth/${provider}/dev-callback`, dev: true });
      return;
    }
    if (!isProviderConnectEnabled(provider)) {
      res.status(501).json({ error: `${provider} integration not configured on this server` });
      return;
    }
    const state = randomBytes(16).toString('hex');
    res.cookie(stateCookieName(provider), state, stateCookieOpts());
    const def = getProvider(provider)!;
    res.json({ url: buildAuthUrl(def, getProviderCreds(provider), state, callbackRedirectUri(opts.publicBaseUrl, provider)) });
  });

  // ── dev 短路回调 (仅 local 且该 provider 配了 dev token 时生效, 否则 handler 内 404) ──
  r.get('/api/integrations/oauth/:provider/dev-callback', opts.sessionMw, (req: Request, res: Response) => {
    void handleDevCallback(req, res, req.params['provider']!, opts.frontendBaseUrl);
  });

  // ── OAuth 回调 ──
  r.get('/api/integrations/oauth/:provider/callback', opts.sessionMw, async (req: Request, res: Response) => {
    const provider = req.params['provider']!;
    const def = getProvider(provider)!;
    const userId = req.session?.user_id;
    if (!userId) {
      res.status(401).json({ error: 'not authenticated' });
      return;
    }
    const { code, state } = req.query as { code?: string; state?: string };
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
    const cookieState = cookies[stateCookieName(provider)];
    res.clearCookie(stateCookieName(provider), { path: '/' });
    if (!code || !state || !cookieState || state !== cookieState) {
      res.status(400).json({ error: 'invalid OAuth state or code' });
      return;
    }
    try {
      const tokens = await exchangeCode(
        def,
        getProviderCreds(provider),
        code,
        callbackRedirectUri(opts.publicBaseUrl, provider),
      );
      const account = await def.fetchAccount(tokens.accessToken);
      const scopes = account.scopes.length ? account.scopes : tokens.scopes;

      const existing = await dao.oauthConnections.getByProviderAccount(provider, account.externalAccountId);
      if (existing && existing.user_id !== userId) {
        res.status(409).json({ error: `this ${def.displayName} account is already linked to another user` });
        return;
      }
      await dao.oauthConnections.upsertByUserAndProvider({
        userId,
        provider,
        externalAccountId: account.externalAccountId,
        externalLogin: account.externalLogin,
        encryptedAccessToken: encryptToken(tokens.accessToken),
        encryptedRefreshToken: encryptOptional(tokens.refreshToken),
        accessTokenExpiresAt: tokens.expiresAt,
        tokenScopes: scopes,
      });
      res.redirect(`${opts.frontendBaseUrl}/desktop?${provider}=ok`);
    } catch (err) {
      console.error(`[oauth:${provider}] callback failed:`, err);
      res.redirect(`${opts.frontendBaseUrl}/desktop?${provider}=error`);
    }
  });

  // ── 容器侧: 返 plaintext token ──
  r.get('/api/me/oauth/:provider/token', opts.containerAuth, async (req: Request, res: Response) => {
    const provider = req.params['provider']!;
    const userId = req.user_id;
    if (!userId) {
      res.status(401).json({ error: 'no user' });
      return;
    }
    if (overTokenRateLimit(`${provider}:${userId}`)) {
      res.status(429).json({ error: 'rate limit exceeded; retry shortly' });
      return;
    }
    let result;
    try {
      result = await getAccessToken(userId, provider);
    } catch (err) {
      console.error(`[oauth:${provider}] token issue failed:`, err);
      res.status(500).json({ error: 'token issue failed' });
      return;
    }
    if (!result) {
      // agent 看到 410 → 提示用户去 web 重新绑定
      res.status(410).json({ error: `no ${provider} connection; connect at the web UI first` });
      return;
    }
    void dao.oauthConnections.touchLastUsed(userId, provider).catch(() => {});
    res.json({ token: result.token });
  });

  // ── 列绑定 (前端展示) ──
  r.get('/api/me/oauth/:provider/connection', opts.sessionMw, async (req: Request, res: Response) => {
    const provider = req.params['provider']!;
    const userId = req.session?.user_id;
    if (!userId) {
      res.status(401).json({ error: 'not authenticated' });
      return;
    }
    const conn = await dao.oauthConnections.getByUserAndProvider(userId, provider);
    if (!conn) {
      res.json({ connected: false });
      return;
    }
    res.json({
      connected: true,
      login: conn.external_login,
      scopes: conn.token_scopes,
      connected_at: conn.connected_at,
      last_used_at: conn.last_used_at,
    });
  });

  // ── 解绑 (revoke + 清 DB) ──
  r.delete('/api/me/oauth/:provider/connection', opts.sessionMw, async (req: Request, res: Response) => {
    const provider = req.params['provider']!;
    const def = getProvider(provider)!;
    const userId = req.session?.user_id;
    if (!userId) {
      res.status(401).json({ error: 'not authenticated' });
      return;
    }
    const conn = await dao.oauthConnections.getByUserAndProvider(userId, provider);
    if (!conn) {
      res.json({ disconnected: true });
      return;
    }
    // 撤 token: provider def 提供 revoke 且 client 凭证齐时调 (dev 短路无凭证, 跳过)。
    const creds = getProviderCreds(provider);
    if (def.revoke && creds.clientId && creds.clientSecret) {
      try {
        await def.revoke(decryptToken(conn.encrypted_access_token), creds);
      } catch (err) {
        // 撤销失败不阻断本地清理 — 用户也可去 provider Settings 手动 revoke
        console.error(`[oauth:${provider}] revoke failed (continuing to delete local record):`, err);
      }
    }
    await dao.oauthConnections.deleteByUserAndProvider(userId, provider);
    res.json({ disconnected: true });
  });

  return r;
};
