/**
 * 动态 OAuth 路由 —— 一个 router 接所有 provider。
 *
 *   GET /api/auth/:provider/start
 *     ↓ 跳到 provider 同意页 (state cookie 防 CSRF)
 *   GET /api/auth/:provider/callback
 *     ↓ 换 token → 取 userinfo → upsert users → 发 session cookie → 302 /desktop
 *
 * 加新 provider 只要在 providers/index.ts 注册一行,不动这里。
 */
import { Router, type Request, type Response, type Router as RouterType } from 'express';
import { randomBytes } from 'node:crypto';
import { signSession, sessionCookieOpts } from './session.js';
import type { OAuthProvider, NormalizedUser } from './providers/types.js';
import { dao } from '../db/index.js';

const STATE_COOKIE = 'lingxi_oauth_state';
const STATE_TTL_MS = 10 * 60 * 1000;

export interface OAuthRouterOpts {
  providers: Record<string, OAuthProvider>;
  sessionSecret: string;
  cookieName: string;
  ttlHours: number;
  publicBaseUrl: string;
  frontendBaseUrl: string;
}

const redirectUriFor = (publicBaseUrl: string, provider: string): string =>
  `${publicBaseUrl}/api/auth/${provider}/callback`;

export const buildOAuthRouter = (opts: OAuthRouterOpts): RouterType => {
  const r = Router();

  r.get('/api/auth/:provider/start', (req: Request, res: Response) => {
    const providerName = req.params['provider']!;
    const provider = opts.providers[providerName];
    if (!provider) return res.status(404).json({ error: `unknown provider: ${providerName}` });

    const state = randomBytes(16).toString('hex');
    res.cookie(STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: STATE_TTL_MS,
      path: '/',
    });

    const redirectUri = redirectUriFor(opts.publicBaseUrl, providerName);
    res.redirect(provider.buildAuthUrl(state, redirectUri));
  });

  r.get('/api/auth/:provider/callback', async (req: Request, res: Response) => {
    const providerName = req.params['provider']!;
    const provider = opts.providers[providerName];
    if (!provider) return res.status(404).json({ error: `unknown provider: ${providerName}` });

    if (req.query['error']) {
      return res.status(400).json({
        error: 'oauth provider returned error',
        detail: String(req.query['error']),
      });
    }

    const code = req.query['code'] as string | undefined;
    const state = req.query['state'] as string | undefined;
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
    const cookieState = cookies?.[STATE_COOKIE];
    if (!code || !state || !cookieState || state !== cookieState) {
      return res.status(400).json({ error: 'invalid state (CSRF)' });
    }
    res.clearCookie(STATE_COOKIE);

    let accessToken: string;
    try {
      const result = await provider.exchangeCode(code, redirectUriFor(opts.publicBaseUrl, providerName));
      accessToken = result.access_token;
    } catch (e) {
      console.error(`[oauth-router] ${providerName} exchangeCode failed:`, e);
      return res.status(502).json({ error: 'oauth token exchange failed' });
    }

    let userinfo: NormalizedUser;
    try {
      userinfo = await provider.fetchUserinfo(accessToken);
    } catch (e) {
      console.error(`[oauth-router] ${providerName} fetchUserinfo failed:`, e);
      return res.status(502).json({ error: 'oauth userinfo fetch failed' });
    }

    const row = await dao.users.upsertByProvider(providerName, userinfo);
    if (!row) return res.status(500).json({ error: 'user upsert failed' });

    const token = signSession({ user_id: row.id }, opts.sessionSecret, opts.ttlHours);
    res.cookie(opts.cookieName, token, sessionCookieOpts(opts.ttlHours));
    res.redirect(`${opts.frontendBaseUrl}/desktop`);
  });

  return r;
};
