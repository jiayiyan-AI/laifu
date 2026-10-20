/**
 * 账号密码登录路由(非 OAuth redirect 流程):
 *   POST /api/auth/password/register  { email, password }
 *   POST /api/auth/password/login     { email, password }
 *   POST /api/auth/password/change    { current_password, new_password }  (需登录)
 *   POST /api/auth/password/forgot    { email }  恒回 202, 异步发重置邮件
 *   POST /api/auth/password/reset     { token, new_password }  不自动登录
 * 注册/登录成功后签发与 OAuth 同一套 session cookie。
 */
import { Router, type Request, type Response, type Router as RouterType } from 'express';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { validateNewPassword, type AuthErrorCode } from '@lingxi/shared';
import { requireSession } from './middleware.js';
import { issueSessionCookie, sessionVersions } from './session-version.js';
import { authRateLimiter, clientIp } from '../lib/rate-limit.js';
import type { SystemMailer } from '../lib/email/system-mailer.js';
import { toMeResponse } from './user-view.js';
import { dao } from '../db/index.js';

export interface PasswordRoutesOpts {
  sessionSecret: string;
  cookieName: string;
  ttlHours: number;
  mailer: SystemMailer;
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

export const buildPasswordRoutes = (opts: PasswordRoutesOpts): RouterType => {
  const r = Router();

  r.post('/api/auth/password/register', async (req: Request, res: Response) => {
    const email = String(req.body?.email ?? '').trim();
    const password = String(req.body?.password ?? '');

    if (!EMAIL_RE.test(email)) return fail(res, 400, 'invalid_email', 'invalid email');
    const pwErr = validateNewPassword(password);
    if (pwErr) return fail(res, 400, pwErr, pwErr.replace(/_/g, ' '));

    // 包 try/catch: Express 4 不捕获 async handler 的 reject, 不包会变成
    // unhandledRejection 直接拖垮整个 gateway 进程 (而非返回 500)。与其它路由一致。
    try {
      const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const created = await dao.users.createPasswordUser({ email, hash });
      if (!created) return fail(res, 409, 'email_taken', 'email already registered');

      const row = await dao.users.getById(created.id);
      if (!row) return res.status(500).json({ error: 'user lookup failed' });

      await issueSessionCookie(res, created.id, opts);
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

      await issueSessionCookie(res, row.id, opts, row.session_version);
      res.status(200).json(toMeResponse(row));
    } catch (err) {
      console.error('[password-routes] login failed:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'login failed' });
    }
  });

  const sessionMw = requireSession({ secret: opts.sessionSecret, cookieName: opts.cookieName, versions: sessionVersions });
  const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
  const RESET_TTL_MINUTES = 30;
  const MIN = 60_000;
  const HOUR = 3_600_000;

  r.post('/api/auth/password/change', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const current = String(req.body?.current_password ?? '');
    const next = String(req.body?.new_password ?? '');
    const pwErr = validateNewPassword(next);
    if (pwErr) return fail(res, 400, pwErr, pwErr.replace(/_/g, ' '));
    if (!authRateLimiter.hit(`change:user:${userId}`, 10, 15 * MIN)) {
      return fail(res, 429, 'rate_limited', 'too many attempts');
    }
    try {
      const auth = await dao.users.getPasswordAuthById(userId);
      if (!auth || auth.provider !== 'password' || !auth.password_hash) {
        return fail(res, 400, 'not_password_account', 'not a password account');
      }
      if (!(await bcrypt.compare(current, auth.password_hash))) {
        return fail(res, 403, 'wrong_password', 'current password incorrect');
      }
      const hash = await bcrypt.hash(next, BCRYPT_ROUNDS);
      const sv = await dao.users.updatePasswordAndBumpSession(userId, hash);
      if (sv === null) return res.status(500).json({ error: 'user vanished' });
      sessionVersions.invalidate(userId);
      await issueSessionCookie(res, userId, opts, sv);
      console.log(`[password-routes] auth.password.change user=${userId} sv=${sv}`);
      res.json({ ok: true });
    } catch (err) {
      console.error('[password-routes] change failed:', err);
      res.status(500).json({ error: 'internal' });
    }
  });

  r.post('/api/auth/password/forgot', async (req: Request, res: Response) => {
    const email = String(req.body?.email ?? '').trim();
    // 无论命中与否都立即回 202, 后续全部异步, 响应时间不泄露邮箱是否注册。
    res.status(202).json({ ok: true });

    if (!EMAIL_RE.test(email)) return;
    const key = email.toLowerCase();
    const ip = clientIp(req);
    const allowed = authRateLimiter.hit(`forgot:ip:${ip}`, 20, HOUR)
      && authRateLimiter.hit(`forgot:email:1m:${key}`, 1, MIN)
      && authRateLimiter.hit(`forgot:email:1h:${key}`, 5, HOUR);
    if (!allowed) {
      console.warn(`[password-routes] auth.password.forgot rate_limited ip=${ip}`);
      return;
    }
    try {
      const row = await dao.users.getPasswordUserByEmail(email);
      console.log(`[password-routes] auth.password.forgot matched=${!!row} ip=${ip}`);
      if (!row || !row.email) return;
      const token = randomBytes(32).toString('base64url');
      await dao.passwordResets.create({ userId: row.id, tokenHash: sha256(token), ttlMinutes: RESET_TTL_MINUTES });
      await opts.mailer.sendPasswordReset(row.email, token);
    } catch (err) {
      console.error('[password-routes] forgot failed (已回 202, 仅记录):', err);
    }
  });

  r.post('/api/auth/password/reset', async (req: Request, res: Response) => {
    const token = String(req.body?.token ?? '').trim();
    const next = String(req.body?.new_password ?? '');
    if (!token) return fail(res, 400, 'invalid_or_expired_token', 'missing token');
    // 先校验新密码再消费 token: 密码不合规时 token 还能留着重试。
    const pwErr = validateNewPassword(next);
    if (pwErr) return fail(res, 400, pwErr, pwErr.replace(/_/g, ' '));
    if (!authRateLimiter.hit(`reset:ip:${clientIp(req)}`, 20, HOUR)) {
      return fail(res, 429, 'rate_limited', 'too many attempts');
    }
    try {
      const userId = await dao.passwordResets.consume(sha256(token));
      if (!userId) return fail(res, 400, 'invalid_or_expired_token', 'invalid or expired token');
      const hash = await bcrypt.hash(next, BCRYPT_ROUNDS);
      const sv = await dao.users.updatePasswordAndBumpSession(userId, hash);
      // 用户在 consume 与 update 之间被删: 视同 token 无效, 不能回 200。
      if (sv === null) return fail(res, 400, 'invalid_or_expired_token', 'invalid or expired token');
      sessionVersions.invalidate(userId);
      console.log(`[password-routes] auth.password.reset user=${userId} sv=${sv}`);
      res.json({ ok: true });
    } catch (err) {
      console.error('[password-routes] reset failed:', err);
      res.status(500).json({ error: 'internal' });
    }
  });

  return r;
};
