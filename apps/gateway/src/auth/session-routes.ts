/**
 * Session 相关路由(不依赖具体 OAuth provider):
 *   GET  /api/auth/me      — 拿当前登录用户
 *   POST /api/auth/logout  — 清 cookie
 *
 * 真正的 OAuth provider 流程在 ./oauth-router.ts。
 */
import { Router, type Request, type Response, type Router as RouterType } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSession } from './middleware.js';
import type { AuthMeResponse } from '@lingxi/shared';

export interface SessionRoutesOpts {
  sb: SupabaseClient;
  sessionSecret: string;
  cookieName: string;
  ttlHours: number;
}

interface UserRow {
  id: string;
  provider: string;
  external_id: string;
  email: string | null;
  nickname: string | null;
  avatar_url: string | null;
}

const toMeResponse = (row: UserRow): AuthMeResponse => ({
  user_id: row.id,
  provider: row.provider,
  external_id: row.external_id,
  email: row.email,
  nickname: row.nickname,
  avatar_url: row.avatar_url,
});

export const buildSessionRoutes = (opts: SessionRoutesOpts): RouterType => {
  const r = Router();
  const sessionMw = requireSession({ secret: opts.sessionSecret, cookieName: opts.cookieName });

  r.get('/api/auth/me', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const { data, error } = await opts.sb
      .from('users')
      .select('id, provider, external_id, email, nickname, avatar_url')
      .eq('id', userId)
      .single();
    if (error || !data) return res.status(401).json({ error: 'user not found' });
    res.json(toMeResponse(data as UserRow));
  });

  r.post('/api/auth/logout', (_req: Request, res: Response) => {
    res.clearCookie(opts.cookieName);
    res.json({ ok: true });
  });

  return r;
};
