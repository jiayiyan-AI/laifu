import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

import { dao } from '../../src/db/index.js';
import { buildPasswordRoutes } from '../../src/auth/password-routes.js';

const SECRET = 'test-secret-do-not-use-in-prod-1234567';
const COOKIE_NAME = 'lingxi_sid';

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(buildPasswordRoutes({ sessionSecret: SECRET, cookieName: COOKIE_NAME, ttlHours: 24 }));
  return app;
};

describe('password-routes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  describe('POST /api/auth/password/register', () => {
    it('成功注册: 创建用户 + set session cookie + 201 AuthMeResponse', async () => {
      vi.mocked(dao.users.createPasswordUser).mockResolvedValue({ id: 'u_new' });
      vi.mocked(dao.users.getById).mockResolvedValue({
        id: 'u_new', provider: 'password', external_id: 'a@b.com',
        email: 'a@b.com', nickname: 'Qiang', avatar_url: null,
      });

      const res = await request(makeApp())
        .post('/api/auth/password/register')
        .send({ email: 'a@b.com', password: 'secret12', nickname: 'Qiang' });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ user_id: 'u_new', provider: 'password', email: 'a@b.com', nickname: 'Qiang' });
      expect(res.headers['set-cookie']?.some((c: string) => c.startsWith(`${COOKIE_NAME}=`))).toBe(true);
      const call = vi.mocked(dao.users.createPasswordUser).mock.calls[0]![0];
      expect(call.hash).not.toBe('secret12');
      expect(bcrypt.compareSync('secret12', call.hash)).toBe(true);
    });

    it('邮箱已存在 → 409 + code=email_taken', async () => {
      vi.mocked(dao.users.createPasswordUser).mockResolvedValue(null);
      const res = await request(makeApp())
        .post('/api/auth/password/register')
        .send({ email: 'a@b.com', password: 'secret12', nickname: 'Qiang' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('email_taken');
    });

    it('密码太短 → 400 + code=password_too_short,不落库', async () => {
      const res = await request(makeApp())
        .post('/api/auth/password/register')
        .send({ email: 'a@b.com', password: 'short', nickname: 'Qiang' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('password_too_short');
      expect(dao.users.createPasswordUser).not.toHaveBeenCalled();
    });

    it('邮箱格式非法 → 400 + code=invalid_email', async () => {
      const res = await request(makeApp())
        .post('/api/auth/password/register')
        .send({ email: 'notanemail', password: 'secret12', nickname: 'Qiang' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_email');
    });

    it('称呼为空 → 400 + code=nickname_required', async () => {
      const res = await request(makeApp())
        .post('/api/auth/password/register')
        .send({ email: 'a@b.com', password: 'secret12', nickname: '   ' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('nickname_required');
    });
  });

  describe('POST /api/auth/password/login', () => {
    it('成功登录: 校验 hash + set cookie + 200 AuthMeResponse', async () => {
      const hash = bcrypt.hashSync('secret12', 10);
      vi.mocked(dao.users.getPasswordUserByEmail).mockResolvedValue({
        id: 'u1', provider: 'password', external_id: 'a@b.com',
        email: 'a@b.com', nickname: 'Qiang', avatar_url: null, password_hash: hash,
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
        email: 'a@b.com', nickname: 'Qiang', avatar_url: null, password_hash: hash,
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
        .send({ email: 'a@b.com', password: 'secret12', nickname: 'Qiang' });
      expect(res.status).toBe(500);
    });
  });
});
