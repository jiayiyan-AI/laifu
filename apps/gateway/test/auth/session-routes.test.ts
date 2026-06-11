import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { buildSessionRoutes } from '../../src/auth/session-routes.js';
import { signSession } from '../../src/auth/session.js';

const SECRET = 'test-secret-do-not-use-in-prod-1234567';
const COOKIE_NAME = 'lingxi_sid';

const validCookie = (userId: string): string =>
  `${COOKIE_NAME}=${signSession({ user_id: userId }, SECRET, 24)}`;

const userRow = (id: string, overrides: Partial<Record<string, unknown>> = {}) => ({
  id,
  provider: 'dev',
  external_id: id,
  email: null,
  nickname: null,
  avatar_url: null,
  ...overrides,
});

const makeApp = (usersDao: any) => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(buildSessionRoutes({
    usersDao,
    sessionSecret: SECRET,
    cookieName: COOKIE_NAME,
    ttlHours: 24,
  }));
  return app;
};

describe('session-routes', () => {
  let usersDao: any;
  beforeEach(() => {
    usersDao = {
      getById: vi.fn(async () => null),
      getTokenVersion: vi.fn(async () => 0),
      upsertByProvider: vi.fn(async () => null),
    };
  });

  describe('GET /api/auth/me', () => {
    it('returns provider/external_id/email/nickname/avatar_url shape', async () => {
      usersDao.getById.mockResolvedValue(
        userRow('u1', { provider: 'google', external_id: '12345', email: 'a@b.com', nickname: 'Alice' }),
      );
      const res = await request(makeApp(usersDao))
        .get('/api/auth/me')
        .set('Cookie', validCookie('u1'));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        user_id: 'u1',
        provider: 'google',
        external_id: '12345',
        email: 'a@b.com',
        nickname: 'Alice',
        avatar_url: null,
      });
    });

    it('401 without cookie', async () => {
      const res = await request(makeApp(usersDao)).get('/api/auth/me');
      expect(res.status).toBe(401);
    });

    it('401 when user row missing (deleted user with stale cookie)', async () => {
      usersDao.getById.mockResolvedValue(null);
      const res = await request(makeApp(usersDao))
        .get('/api/auth/me')
        .set('Cookie', validCookie('uX'));
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('clears cookie + returns {ok:true}', async () => {
      const res = await request(makeApp(usersDao)).post('/api/auth/logout');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(res.headers['set-cookie']?.[0]).toMatch(/lingxi_sid=;/);
    });
  });

});
