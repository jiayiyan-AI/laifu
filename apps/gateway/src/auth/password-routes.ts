/**
 * 账号密码登录路由(非 OAuth redirect 流程):
 *   POST /api/auth/password/register  { email, password, nickname }
 *   POST /api/auth/password/login     { email, password }
 * 成功后签发与 OAuth 同一套 session cookie。
 */
import { Router, type Request, type Response, type Router as RouterType } from 'express';
import bcrypt from 'bcryptjs';
import { signSession, sessionCookieOpts } from './session.js';
import type { AuthMeResponse } from '@lingxi/shared';
import { dao } from '../db/index.js';

export interface PasswordRoutesOpts {
  sessionSecret: string;
  cookieName: string;
  ttlHours: number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;
const BCRYPT_ROUNDS = 10;
// 防枚举: 邮箱不存在时也跑一次 bcrypt 比较, 抹平时序差异。模块加载时算一次。
const DUMMY_HASH = bcrypt.hashSync('lingxi-dummy-password', BCRYPT_ROUNDS);

const toMeResponse = (row: {
  id: string; provider: string; external_id: string;
  email: string | null; nickname: string | null; avatar_url: string | null;
}): AuthMeResponse => ({
  user_id: row.id,
  provider: row.provider,
  external_id: row.external_id,
  email: row.email,
  nickname: row.nickname,
  avatar_url: row.avatar_url,
});

const setSessionCookie = (res: Response, opts: PasswordRoutesOpts, userId: string): void => {
  const token = signSession({ user_id: userId }, opts.sessionSecret, opts.ttlHours);
  res.cookie(opts.cookieName, token, sessionCookieOpts(opts.ttlHours));
};

export const buildPasswordRoutes = (opts: PasswordRoutesOpts): RouterType => {
  const r = Router();

  r.post('/api/auth/password/register', async (req: Request, res: Response) => {
    const email = String(req.body?.email ?? '').trim();
    const password = String(req.body?.password ?? '');
    const nickname = String(req.body?.nickname ?? '').trim();

    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid email' });
    if (password.length < MIN_PASSWORD) return res.status(400).json({ error: 'password too short' });
    if (!nickname) return res.status(400).json({ error: 'nickname required' });

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const created = await dao.users.createPasswordUser({ email, nickname, hash });
    if (!created) return res.status(409).json({ error: 'email already registered' });

    const row = await dao.users.getById(created.id);
    if (!row) return res.status(500).json({ error: 'user lookup failed' });

    setSessionCookie(res, opts, created.id);
    res.status(201).json(toMeResponse(row));
  });

  r.post('/api/auth/password/login', async (req: Request, res: Response) => {
    const email = String(req.body?.email ?? '').trim();
    const password = String(req.body?.password ?? '');
    if (!email || !password) return res.status(401).json({ error: 'invalid credentials' });

    const row = await dao.users.getPasswordUserByEmail(email);
    const ok = await bcrypt.compare(password, row?.password_hash ?? DUMMY_HASH);
    if (!row || !ok) return res.status(401).json({ error: 'invalid credentials' });

    setSessionCookie(res, opts, row.id);
    res.status(200).json(toMeResponse(row));
  });

  return r;
};
