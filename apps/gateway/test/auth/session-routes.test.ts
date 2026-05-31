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

const makeApp = (enableDevLogin: boolean, sb: any) => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(buildSessionRoutes({
    sb,
    sessionSecret: SECRET,
    cookieName: COOKIE_NAME,
    ttlHours: 24,
    enableDevLogin,
  }));
  return app;
};

describe('session-routes', () => {
  let sb: any;
  beforeEach(() => {
    sb = {
      from: vi.fn(() => sb),
      select: vi.fn(() => sb),
      upsert: vi.fn(() => sb),
      eq: vi.fn(() => sb),
      single: vi.fn(),
    };
  });

  describe('GET /api/auth/me', () => {
    it('returns provider/external_id/email/nickname/avatar_url shape', async () => {
      sb.single = vi.fn(() => Promise.resolve({
        data: userRow('u1', { provider: 'google', external_id: '12345', email: 'a@b.com', nickname: 'Alice' }),
        error: null,
      }));
      const res = await request(makeApp(true, sb))
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
      const res = await request(makeApp(true, sb)).get('/api/auth/me');
      expect(res.status).toBe(401);
    });

    it('401 when user row missing (deleted user with stale cookie)', async () => {
      sb.single = vi.fn(() => Promise.resolve({ data: null, error: { code: 'PGRST116' } }));
      const res = await request(makeApp(true, sb))
        .get('/api/auth/me')
        .set('Cookie', validCookie('uX'));
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('clears cookie + returns {ok:true}', async () => {
      const res = await request(makeApp(true, sb)).post('/api/auth/logout');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      // express sets a clearing cookie header
      expect(res.headers['set-cookie']?.[0]).toMatch(/lingxi_sid=;/);
    });
  });

  describe('POST /api/auth/dev/login (dev mode only)', () => {
    it('upserts users with provider=dev + external_id, sets session cookie', async () => {
      sb.single = vi.fn(() => Promise.resolve({
        data: userRow('u_new', { provider: 'dev', external_id: 'alice', nickname: 'Alice' }),
        error: null,
      }));
      const res = await request(makeApp(true, sb))
        .post('/api/auth/dev/login')
        .send({ external_id: 'alice', nickname: 'Alice' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        user_id: 'u_new',
        provider: 'dev',
        external_id: 'alice',
        email: null,
        nickname: 'Alice',
        avatar_url: null,
      });
      // verify upsert call shape
      expect(sb.upsert).toHaveBeenCalledWith(
        { provider: 'dev', external_id: 'alice', nickname: 'Alice', email: null },
        { onConflict: 'provider,external_id' },
      );
      // session cookie set
      expect(res.headers['set-cookie']?.[0]).toMatch(/lingxi_sid=/);
    });

    it('400 when external_id missing', async () => {
      const res = await request(makeApp(true, sb))
        .post('/api/auth/dev/login')
        .send({ nickname: 'Alice' });
      expect(res.status).toBe(400);
    });

    it('500 when DB upsert fails', async () => {
      sb.single = vi.fn(() => Promise.resolve({ data: null, error: { message: 'unique violation' } }));
      const res = await request(makeApp(true, sb))
        .post('/api/auth/dev/login')
        .send({ external_id: 'alice' });
      expect(res.status).toBe(500);
    });

    it('404 when dev login disabled', async () => {
      const res = await request(makeApp(false, sb))
        .post('/api/auth/dev/login')
        .send({ external_id: 'alice' });
      expect(res.status).toBe(404);
    });
  });
});
