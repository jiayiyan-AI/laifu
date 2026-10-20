import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import { createHash } from 'node:crypto';

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

import { dao } from '../../src/db/index.js';
import { buildPasswordRoutes } from '../../src/auth/password-routes.js';
import { authRateLimiter } from '../../src/lib/rate-limit.js';
import { sessionVersions } from '../../src/auth/session-version.js';
import { signSession, verifySession } from '../../src/auth/session.js';

const SECRET = 'test-secret-do-not-use-in-prod-1234567';
const COOKIE_NAME = 'lingxi_sid';

const mailer = { sendPasswordReset: vi.fn(async () => {}) };
const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(buildPasswordRoutes({ sessionSecret: SECRET, cookieName: COOKIE_NAME, ttlHours: 24, mailer }));
  return app;
};
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const cookieFor = (userId: string, sv: number) => `${COOKIE_NAME}=${signSession({ user_id: userId, sv }, SECRET, 24)}`;
const flush = () => new Promise((r) => setImmediate(r));

describe('password-routes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    authRateLimiter.reset();
    sessionVersions.invalidate('u1');
  });

  describe('POST /api/auth/password/register', () => {
    it('成功注册: 创建用户 + set session cookie + 201 AuthMeResponse', async () => {
      vi.mocked(dao.users.createPasswordUser).mockResolvedValue({ id: 'u_new' });
      vi.mocked(dao.users.getSessionVersion).mockResolvedValue(0);
      vi.mocked(dao.users.getById).mockResolvedValue({
        id: 'u_new', provider: 'password', external_id: 'a@b.com',
        email: 'a@b.com', nickname: 'Qiang', avatar_url: null,
      });

      const res = await request(makeApp())
        .post('/api/auth/password/register')
        .send({ email: 'a@b.com', password: 'secret12' });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ user_id: 'u_new', provider: 'password', email: 'a@b.com' });
      expect(res.headers['set-cookie']?.some((c: string) => c.startsWith(`${COOKIE_NAME}=`))).toBe(true);
      const call = vi.mocked(dao.users.createPasswordUser).mock.calls[0]![0];
      expect(call.hash).not.toBe('secret12');
      expect(bcrypt.compareSync('secret12', call.hash)).toBe(true);
    });

    it('邮箱已存在 → 409 + code=email_taken', async () => {
      vi.mocked(dao.users.createPasswordUser).mockResolvedValue(null);
      const res = await request(makeApp())
        .post('/api/auth/password/register')
        .send({ email: 'a@b.com', password: 'secret12' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('email_taken');
    });

    it('密码太短 → 400 + code=password_too_short,不落库', async () => {
      const res = await request(makeApp())
        .post('/api/auth/password/register')
        .send({ email: 'a@b.com', password: 'short' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('password_too_short');
      expect(dao.users.createPasswordUser).not.toHaveBeenCalled();
    });

    it('邮箱格式非法 → 400 + code=invalid_email', async () => {
      const res = await request(makeApp())
        .post('/api/auth/password/register')
        .send({ email: 'notanemail', password: 'secret12' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_email');
    });
  });

  describe('POST /api/auth/password/login', () => {
    it('成功登录: 校验 hash + set cookie + 200 AuthMeResponse', async () => {
      const hash = bcrypt.hashSync('secret12', 10);
      vi.mocked(dao.users.getPasswordUserByEmail).mockResolvedValue({
        id: 'u1', provider: 'password', external_id: 'a@b.com',
        email: 'a@b.com', nickname: 'Qiang', avatar_url: null, password_hash: hash, session_version: 0,
      });

      const res = await request(makeApp())
        .post('/api/auth/password/login')
        .send({ email: 'a@b.com', password: 'secret12' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ user_id: 'u1', provider: 'password' });
      expect(res.headers['set-cookie']?.some((c: string) => c.startsWith(`${COOKIE_NAME}=`))).toBe(true);
    });

    it('密码错 → 401', async () => {
      const hash = bcrypt.hashSync('secret12', 10);
      vi.mocked(dao.users.getPasswordUserByEmail).mockResolvedValue({
        id: 'u1', provider: 'password', external_id: 'a@b.com',
        email: 'a@b.com', nickname: 'Qiang', avatar_url: null, password_hash: hash, session_version: 0,
      });
      const res = await request(makeApp())
        .post('/api/auth/password/login')
        .send({ email: 'a@b.com', password: 'wrongpass' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_credentials');
    });

    it('邮箱不存在 → 401(与密码错同文案,防枚举)', async () => {
      vi.mocked(dao.users.getPasswordUserByEmail).mockResolvedValue(null);
      const res = await request(makeApp())
        .post('/api/auth/password/login')
        .send({ email: 'nobody@b.com', password: 'secret12' });
      expect(res.status).toBe(401);
    });

    it('邮箱不存在时仍跑一次 bcrypt 比较(防时序枚举)', async () => {
      vi.mocked(dao.users.getPasswordUserByEmail).mockResolvedValue(null);
      const compareSpy = vi.spyOn(bcrypt, 'compare');
      const res = await request(makeApp())
        .post('/api/auth/password/login')
        .send({ email: 'nobody@b.com', password: 'secret12' });
      expect(res.status).toBe(401);
      expect(compareSpy).toHaveBeenCalledTimes(1);
    });

    it('DAO 抛错 → 500(不让 async reject 拖垮进程)', async () => {
      vi.mocked(dao.users.getPasswordUserByEmail).mockRejectedValue(new Error('db down'));
      const res = await request(makeApp())
        .post('/api/auth/password/login')
        .send({ email: 'a@b.com', password: 'secret12' });
      expect(res.status).toBe(500);
    });
  });

  // 回归: handler 内任何 DB/bcrypt 异常必须被 catch 成 500, 不能变 unhandledRejection
  // 拖垮整个 gateway 进程 (现场 bug: users 表缺 password_hash 列时 register 直接 crash)。
  describe('错误不拖垮进程', () => {
    it('register: createPasswordUser 抛错 → 500', async () => {
      vi.mocked(dao.users.createPasswordUser).mockRejectedValue(
        new Error('column "password_hash" does not exist'),
      );
      const res = await request(makeApp())
        .post('/api/auth/password/register')
        .send({ email: 'a@b.com', password: 'secret12' });
      expect(res.status).toBe(500);
    });
  });

  describe('POST /api/auth/password/change', () => {
    const pwUser = () => ({ provider: 'password', password_hash: bcrypt.hashSync('oldpass12', 10) });

    it('成功: 写新 hash + sv+1 + 换发带新 sv 的 cookie', async () => {
      vi.mocked(dao.users.getSessionVersion).mockResolvedValue(0);
      vi.mocked(dao.users.getPasswordAuthById).mockResolvedValue(pwUser());
      vi.mocked(dao.users.updatePasswordAndBumpSession).mockResolvedValue(1);
      const res = await request(makeApp()).post('/api/auth/password/change')
        .set('Cookie', cookieFor('u1', 0))
        .send({ current_password: 'oldpass12', new_password: 'newpass12' });
      expect(res.status).toBe(200);
      const [uid, hash] = vi.mocked(dao.users.updatePasswordAndBumpSession).mock.calls[0]!;
      expect(uid).toBe('u1');
      expect(bcrypt.compareSync('newpass12', hash)).toBe(true);
      const setCookie = res.headers['set-cookie']!.find((c: string) => c.startsWith(`${COOKIE_NAME}=`))!;
      const jwt = setCookie.split(';')[0]!.slice(COOKIE_NAME.length + 1);
      expect(verifySession(jwt, SECRET).sv).toBe(1);
    });

    it('旧密码错 → 403 wrong_password, 不写库', async () => {
      vi.mocked(dao.users.getSessionVersion).mockResolvedValue(0);
      vi.mocked(dao.users.getPasswordAuthById).mockResolvedValue(pwUser());
      const res = await request(makeApp()).post('/api/auth/password/change')
        .set('Cookie', cookieFor('u1', 0))
        .send({ current_password: 'WRONG', new_password: 'newpass12' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('wrong_password');
      expect(dao.users.updatePasswordAndBumpSession).not.toHaveBeenCalled();
    });

    it('OAuth 用户 → 400 not_password_account', async () => {
      vi.mocked(dao.users.getSessionVersion).mockResolvedValue(0);
      vi.mocked(dao.users.getPasswordAuthById).mockResolvedValue({ provider: 'google', password_hash: null });
      const res = await request(makeApp()).post('/api/auth/password/change')
        .set('Cookie', cookieFor('u1', 0))
        .send({ current_password: 'x', new_password: 'newpass12' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('not_password_account');
    });

    it('新密码太短 → 400 password_too_short', async () => {
      vi.mocked(dao.users.getSessionVersion).mockResolvedValue(0);
      const res = await request(makeApp()).post('/api/auth/password/change')
        .set('Cookie', cookieFor('u1', 0))
        .send({ current_password: 'oldpass12', new_password: 'short' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('password_too_short');
    });

    it('未登录 → 401; 旧 sv 的 cookie → 401', async () => {
      expect((await request(makeApp()).post('/api/auth/password/change').send({})).status).toBe(401);
      vi.mocked(dao.users.getSessionVersion).mockResolvedValue(1);
      const res = await request(makeApp()).post('/api/auth/password/change')
        .set('Cookie', cookieFor('u1', 0))
        .send({ current_password: 'oldpass12', new_password: 'newpass12' });
      expect(res.status).toBe(401);
    });

    it('15 分钟内第 11 次 → 429 rate_limited', async () => {
      vi.mocked(dao.users.getSessionVersion).mockResolvedValue(0);
      vi.mocked(dao.users.getPasswordAuthById).mockResolvedValue(pwUser());
      const app = makeApp();
      for (let i = 0; i < 10; i++) {
        await request(app).post('/api/auth/password/change').set('Cookie', cookieFor('u1', 0))
          .send({ current_password: 'WRONG', new_password: 'newpass12' });
      }
      const res = await request(app).post('/api/auth/password/change').set('Cookie', cookieFor('u1', 0))
        .send({ current_password: 'oldpass12', new_password: 'newpass12' });
      expect(res.status).toBe(429);
      expect(res.body.code).toBe('rate_limited');
    });
  });

  describe('POST /api/auth/password/forgot', () => {
    const row = { id: 'u1', provider: 'password', external_id: 'a@b.com', email: 'a@b.com', nickname: null, avatar_url: null, password_hash: 'h', session_version: 0 };

    it('邮箱存在: 202 + 存 sha256 + 发信(原文 token 只进邮件)', async () => {
      vi.mocked(dao.users.getPasswordUserByEmail).mockResolvedValue(row);
      const res = await request(makeApp()).post('/api/auth/password/forgot').send({ email: 'a@b.com' });
      await flush();
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ ok: true });
      const [to, token] = mailer.sendPasswordReset.mock.calls[0]! as [string, string];
      expect(to).toBe('a@b.com');
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const created = vi.mocked(dao.passwordResets.create).mock.calls[0]![0];
      expect(created).toEqual({ userId: 'u1', tokenHash: sha256(token), ttlMinutes: 30 });
    });

    it('邮箱前后空格+大写也命中(查询用 trim 后的值)', async () => {
      vi.mocked(dao.users.getPasswordUserByEmail).mockResolvedValue(row);
      await request(makeApp()).post('/api/auth/password/forgot').send({ email: '  A@B.com ' });
      expect(vi.mocked(dao.users.getPasswordUserByEmail).mock.calls[0]![0]).toBe('A@B.com');
      // getPasswordUserByEmail 内部会 toLowerCase, 大小写由 DAO 处理
    });

    it('邮箱不存在 / 格式非法 / OAuth 用户: 响应与存在时完全一致, 不发信', async () => {
      vi.mocked(dao.users.getPasswordUserByEmail).mockResolvedValue(null); // OAuth 用户也查不到(只查 provider=password)
      for (const email of ['nobody@b.com', 'notanemail', '']) {
        const res = await request(makeApp()).post('/api/auth/password/forgot').send({ email });
        expect(res.status).toBe(202);
        expect(res.body).toEqual({ ok: true });
      }
      await flush();
      expect(mailer.sendPasswordReset).not.toHaveBeenCalled();
      expect(dao.passwordResets.create).not.toHaveBeenCalled();
    });

    it('同邮箱 60s 内第二次: 仍 202, 但不再发信', async () => {
      vi.mocked(dao.users.getPasswordUserByEmail).mockResolvedValue(row);
      const app = makeApp();
      await request(app).post('/api/auth/password/forgot').send({ email: 'a@b.com' });
      const res = await request(app).post('/api/auth/password/forgot').send({ email: 'a@b.com' });
      await flush();
      expect(res.status).toBe(202);
      expect(mailer.sendPasswordReset).toHaveBeenCalledTimes(1);
    });

    it('matched 日志带上解析出的 ip (便于核对限流 key), 不含邮箱和 token', async () => {
      vi.mocked(dao.users.getPasswordUserByEmail).mockResolvedValue(row);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      await request(makeApp()).post('/api/auth/password/forgot').send({ email: 'a@b.com' });
      await flush();
      const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes('auth.password.forgot matched='));
      expect(line).toMatch(/matched=true ip=\S+/);
      expect(line).not.toContain('a@b.com');
      const token = (mailer.sendPasswordReset.mock.calls[0]! as [string, string])[1];
      for (const c of log.mock.calls) expect(c.map(String).join(' ')).not.toContain(token);
    });

    it('发信失败不影响 202', async () => {
      vi.mocked(dao.users.getPasswordUserByEmail).mockResolvedValue(row);
      mailer.sendPasswordReset.mockRejectedValueOnce(new Error('resend down'));
      const res = await request(makeApp()).post('/api/auth/password/forgot').send({ email: 'a@b.com' });
      await flush();
      expect(res.status).toBe(202);
    });
  });

  describe('POST /api/auth/password/reset', () => {
    it('成功: 消费 sha256(token) → 写 hash + sv+1 → 200', async () => {
      vi.mocked(dao.passwordResets.consume).mockResolvedValue('u1');
      vi.mocked(dao.users.updatePasswordAndBumpSession).mockResolvedValue(2);
      const res = await request(makeApp()).post('/api/auth/password/reset').send({ token: 'tok1', new_password: 'newpass12' });
      expect(res.status).toBe(200);
      expect(vi.mocked(dao.passwordResets.consume).mock.calls[0]![0]).toBe(sha256('tok1'));
      const [uid, hash] = vi.mocked(dao.users.updatePasswordAndBumpSession).mock.calls[0]!;
      expect(uid).toBe('u1');
      expect(bcrypt.compareSync('newpass12', hash)).toBe(true);
      expect(res.headers['set-cookie']).toBeUndefined(); // 不自动登录
    });

    it('token 首尾空白被 trim', async () => {
      vi.mocked(dao.passwordResets.consume).mockResolvedValue('u1');
      await request(makeApp()).post('/api/auth/password/reset').send({ token: '  tok1\n', new_password: 'newpass12' });
      expect(vi.mocked(dao.passwordResets.consume).mock.calls[0]![0]).toBe(sha256('tok1'));
    });

    it('无效/过期/已用 → 400 invalid_or_expired_token, 不写密码', async () => {
      vi.mocked(dao.passwordResets.consume).mockResolvedValue(null);
      const res = await request(makeApp()).post('/api/auth/password/reset').send({ token: 'tok1', new_password: 'newpass12' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_or_expired_token');
      expect(dao.users.updatePasswordAndBumpSession).not.toHaveBeenCalled();
    });

    it('新密码不合规时不消费 token(用户改个密码还能重试)', async () => {
      const res = await request(makeApp()).post('/api/auth/password/reset').send({ token: 'tok1', new_password: 'short' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('password_too_short');
      expect(dao.passwordResets.consume).not.toHaveBeenCalled();
    });

    it('空 token → 400 invalid_or_expired_token', async () => {
      const res = await request(makeApp()).post('/api/auth/password/reset').send({ token: '', new_password: 'newpass12' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_or_expired_token');
    });

    it('用户在 consume 与 update 之间被删 → 400 invalid_or_expired_token', async () => {
      vi.mocked(dao.passwordResets.consume).mockResolvedValue('u1');
      vi.mocked(dao.users.updatePasswordAndBumpSession).mockResolvedValue(null);
      const res = await request(makeApp()).post('/api/auth/password/reset').send({ token: 'tok1', new_password: 'newpass12' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_or_expired_token');
    });
  });
});
