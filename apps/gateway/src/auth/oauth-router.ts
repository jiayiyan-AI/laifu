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
import type { SupabaseClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import { signSession, sessionCookieOpts } from './session.js';
import type { OAuthProvider, NormalizedUser } from './providers/types.js';

const STATE_COOKIE = 'lingxi_oauth_state';
const STATE_TTL_MS = 10 * 60 * 1000;     // 10 分钟,够用户在同意页磨蹭一会

export interface OAuthRouterOpts {
  sb: SupabaseClient;
  providers: Record<string, OAuthProvider>;
  sessionSecret: string;
  cookieName: string;
  ttlHours: number;
  publicBaseUrl: string;        // gateway 自己的入口,用来构造 OAuth callback redirect_uri
  frontendBaseUrl: string;      // 前端入口,OAuth 成功后浏览器 302 跳回的目标
}

interface UserRow {
  id: string;
}

const redirectUriFor = (publicBaseUrl: string, provider: string): string =>
  `${publicBaseUrl}/api/auth/${provider}/callback`;

const upsertUser = async (
  sb: SupabaseClient,
  provider: string,
  user: NormalizedUser,
): Promise<UserRow | null> => {
  const { data, error } = await sb
    .from('users')
    .upsert(
      {
        provider,
        external_id: user.external_id,
        email: user.email,
        nickname: user.name,
        avatar_url: user.avatar_url,
      },
      { onConflict: 'provider,external_id' },
    )
    .select('id')
    .single();
  if (error || !data) {
    console.error('[oauth-router] upsert user failed:', error);
    return null;
  }
  return data as UserRow;
};

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

    // 1. provider 自己报告错(用户拒绝授权 / 配置错等)
    if (req.query['error']) {
      return res.status(400).json({
        error: 'oauth provider returned error',
        detail: String(req.query['error']),
      });
    }

    // 2. state CSRF 校验
    const code = req.query['code'] as string | undefined;
    const state = req.query['state'] as string | undefined;
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
    const cookieState = cookies?.[STATE_COOKIE];
    if (!code || !state || !cookieState || state !== cookieState) {
      return res.status(400).json({ error: 'invalid state (CSRF)' });
    }
    res.clearCookie(STATE_COOKIE);

    // 3. code → access_token
    let accessToken: string;
    try {
      const result = await provider.exchangeCode(code, redirectUriFor(opts.publicBaseUrl, providerName));
      accessToken = result.access_token;
    } catch (e) {
      console.error(`[oauth-router] ${providerName} exchangeCode failed:`, e);
      return res.status(502).json({ error: 'oauth token exchange failed' });
    }

    // 4. access_token → userinfo
    let userinfo: NormalizedUser;
    try {
      userinfo = await provider.fetchUserinfo(accessToken);
    } catch (e) {
      console.error(`[oauth-router] ${providerName} fetchUserinfo failed:`, e);
      return res.status(502).json({ error: 'oauth userinfo fetch failed' });
    }

    // 5. upsert user(以 (provider, external_id) 为复合主键)
    const row = await upsertUser(opts.sb, providerName, userinfo);
    if (!row) return res.status(500).json({ error: 'user upsert failed' });

    // 6. 发 session cookie + 跳回前端
    //    跨端口绝对跳转: callback 命中 gateway(:9000),浏览器需要回到前端(:3000)。
    //    localhost 上 cookie 不分端口,所以 :9000 set 的 cookie 在 :3000 的 fetch 里也会带上。
    const token = signSession({ user_id: row.id }, opts.sessionSecret, opts.ttlHours);
    res.cookie(opts.cookieName, token, sessionCookieOpts(opts.ttlHours));
    res.redirect(`${opts.frontendBaseUrl}/desktop`);
  });

  return r;
};
