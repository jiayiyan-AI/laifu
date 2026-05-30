import { Router, type Request, type Response, type Router as RouterType } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import { signSession, sessionCookieOpts } from './session.js';
import { requireSession } from './middleware.js';

export interface OAuthRouterOpts {
  sb: SupabaseClient;
  sessionSecret: string;
  cookieName: string;
  ttlHours: number;
  mode: 'dev' | 'wechat';
  wechat: {
    appId: string;
    secret: string;
    redirectUri: string;
  };
}

const STATE_COOKIE = 'wx_state';

const setSessionCookie = (res: Response, opts: OAuthRouterOpts, userId: string) => {
  const token = signSession({ user_id: userId }, opts.sessionSecret, opts.ttlHours);
  res.cookie(opts.cookieName, token, sessionCookieOpts(opts.ttlHours));
};

export const buildOAuthRouter = (opts: OAuthRouterOpts): RouterType => {
  const r = Router();

  // === Always-available routes ===
  r.get('/api/auth/me', requireSession({ secret: opts.sessionSecret, cookieName: opts.cookieName }),
    async (req: Request, res: Response) => {
      const userId = req.session!.user_id;
      const { data, error } = await opts.sb.from('users').select('*').eq('id', userId).single();
      if (error || !data) return res.status(401).json({ error: 'user not found' });
      res.json({
        user_id: (data as any).id,
        wx_unionid: (data as any).wx_unionid,
        nickname: (data as any).nickname ?? null,
        avatar_url: (data as any).avatar_url ?? null,
      });
    });

  r.post('/api/auth/logout', (_req: Request, res: Response) => {
    res.clearCookie(opts.cookieName);
    res.json({ ok: true });
  });

  // === Dev mode only ===
  if (opts.mode === 'dev') {
    r.post('/api/auth/dev/login', async (req: Request, res: Response) => {
      const { wx_unionid, nickname } = (req.body ?? {}) as { wx_unionid?: string; nickname?: string };
      if (!wx_unionid) return res.status(400).json({ error: 'wx_unionid required' });

      const { data, error } = await opts.sb
        .from('users')
        .upsert({ wx_unionid, nickname: nickname ?? null }, { onConflict: 'wx_unionid' })
        .select('*')
        .single();

      if (error || !data) return res.status(500).json({ error: error?.message ?? 'upsert failed' });

      const row = data as { id: string; wx_unionid: string; nickname: string | null; avatar_url: string | null };
      setSessionCookie(res, opts, row.id);
      res.json({
        user_id: row.id,
        wx_unionid: row.wx_unionid,
        nickname: row.nickname,
        avatar_url: row.avatar_url,
      });
    });
  }

  // === Wechat mode only ===
  if (opts.mode === 'wechat') {
    r.get('/api/auth/wechat/start', (_req: Request, res: Response) => {
      const state = randomBytes(16).toString('hex');
      res.cookie(STATE_COOKIE, state, { httpOnly: true, sameSite: 'lax', maxAge: 600_000, path: '/' });

      const params = new URLSearchParams({
        appid: opts.wechat.appId,
        redirect_uri: opts.wechat.redirectUri,
        response_type: 'code',
        scope: 'snsapi_login',
        state,
      });
      res.redirect(`https://open.weixin.qq.com/connect/qrconnect?${params.toString()}#wechat_redirect`);
    });

    r.get('/api/auth/wechat/callback', async (req: Request, res: Response) => {
      const code = req.query['code'] as string | undefined;
      const state = req.query['state'] as string | undefined;
      const cookieState = (req as Request & { cookies?: Record<string, string> }).cookies?.[STATE_COOKIE];

      if (!code || !state || !cookieState || state !== cookieState) {
        return res.status(400).json({ error: 'invalid state (CSRF)' });
      }
      res.clearCookie(STATE_COOKIE);

      // 1. code → access_token + openid
      const tokenUrl = `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${opts.wechat.appId}&secret=${opts.wechat.secret}&code=${code}&grant_type=authorization_code`;
      const tokenResp = await fetch(tokenUrl).then((r) => r.json()) as { access_token?: string; openid?: string; unionid?: string };

      if (!tokenResp.access_token || !tokenResp.openid) {
        return res.status(502).json({ error: 'wechat token exchange failed' });
      }

      // 2. access_token → userinfo
      const infoUrl = `https://api.weixin.qq.com/sns/userinfo?access_token=${tokenResp.access_token}&openid=${tokenResp.openid}`;
      const info = await fetch(infoUrl).then((r) => r.json()) as { unionid?: string; nickname?: string; headimgurl?: string };

      const unionid = info.unionid ?? tokenResp.unionid;
      if (!unionid) return res.status(502).json({ error: 'no unionid' });

      // 3. UPSERT user
      const { data, error } = await opts.sb
        .from('users')
        .upsert(
          { wx_unionid: unionid, nickname: info.nickname ?? null, avatar_url: info.headimgurl ?? null },
          { onConflict: 'wx_unionid' },
        )
        .select('*')
        .single();

      if (error || !data) return res.status(500).json({ error: error?.message ?? 'upsert failed' });

      setSessionCookie(res, opts, (data as { id: string }).id);
      res.redirect('/desktop');
    });
  }

  return r;
};
