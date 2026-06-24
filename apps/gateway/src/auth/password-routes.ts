/**
 * 账号密码登录路由(非 OAuth redirect 流程):
 *   POST /api/auth/password/register  { email, password }
 *   POST /api/auth/password/login     { email, password }
 * 成功后签发与 OAuth 同一套 session cookie。
 */
import { Router, type Request, type Response, type Router as RouterType } from 'express';
import bcrypt from 'bcryptjs';
import { MIN_PASSWORD_LENGTH, type AuthErrorCode } from '@lingxi/shared';
import { signSession, sessionCookieOpts } from './session.js';
import { toMeResponse } from './user-view.js';
import { dao } from '../db/index.js';

export interface PasswordRoutesOpts {
  sessionSecret: string;
  cookieName: string;
  ttlHours: number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BCRYPT_ROUNDS = 10;

// 校验/冲突类响应统一带 code: 前端据此给精确文案, 后端同时 warn 一行
// (这些分支以前静默 return, 导致"没有后端 log"——排障时看不到真实原因)。
const fail = (res: Response, status: number, code: AuthErrorCode, error: string): void => {
  console.warn(`[password-routes] ${code} (${status}): ${error}`);
  res.status(status).json({ error, code });
};
// 防枚举: 邮箱不存在时也跑一次 bcrypt 比较, 抹平时序差异。模块加载时算一次。
const DUMMY_HASH = bcrypt.hashSync('lingxi-dummy-password', BCRYPT_ROUNDS);

const setSessionCookie = (res: Response, opts: PasswordRoutesOpts, userId: string): void => {
  const token = signSession({ user_id: userId }, opts.sessionSecret, opts.ttlHours);
  res.cookie(opts.cookieName, token, sessionCookieOpts(opts.ttlHours));
};

export const buildPasswordRoutes = (opts: PasswordRoutesOpts): RouterType => {
  const r = Router();

  r.post('/api/auth/password/register', async (req: Request, res: Response) => {
    const email = String(req.body?.email ?? '').trim();
    const password = String(req.body?.password ?? '');

    if (!EMAIL_RE.test(email)) return fail(res, 400, 'invalid_email', 'invalid email');
    if (password.length < MIN_PASSWORD_LENGTH) return fail(res, 400, 'password_too_short', 'password too short');

    // 包 try/catch: Express 4 不捕获 async handler 的 reject, 不包会变成
    // unhandledRejection 直接拖垮整个 gateway 进程 (而非返回 500)。与其它路由一致。
    try {
      const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const created = await dao.users.createPasswordUser({ email, hash });
      if (!created) return fail(res, 409, 'email_taken', 'email already registered');

      const row = await dao.users.getById(created.id);
      if (!row) return res.status(500).json({ error: 'user lookup failed' });

      setSessionCookie(res, opts, created.id);
      res.status(201).json(toMeResponse(row));
    } catch (err) {
      console.error('[password-routes] register failed:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'register failed' });
    }
  });

  r.post('/api/auth/password/login', async (req: Request, res: Response) => {
    const email = String(req.body?.email ?? '').trim();
    const password = String(req.body?.password ?? '');
    if (!email || !password) return fail(res, 401, 'invalid_credentials', 'invalid credentials');

    try {
      const row = await dao.users.getPasswordUserByEmail(email);
      const ok = await bcrypt.compare(password, row?.password_hash ?? DUMMY_HASH);
      if (!row || !ok) return fail(res, 401, 'invalid_credentials', 'invalid credentials');

      setSessionCookie(res, opts, row.id);
      res.status(200).json(toMeResponse(row));
    } catch (err) {
      console.error('[password-routes] login failed:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'login failed' });
    }
  });

  return r;
};
