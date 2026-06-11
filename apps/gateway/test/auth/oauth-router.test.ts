import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { buildOAuthRouter } from '../../src/auth/oauth-router.js';
import type { OAuthProvider } from '../../src/auth/providers/types.js';

const SECRET = 'test-secret-do-not-use-in-prod-1234567';
const COOKIE_NAME = 'lingxi_sid';
const STATE_COOKIE = 'lingxi_oauth_state';
const PUBLIC_BASE = 'http://localhost:9000';
const FRONTEND_BASE = 'http://localhost:3000';

const makeMockProvider = (): OAuthProvider => ({
  buildAuthUrl: vi.fn((state, redirectUri) =>
    `https://mock.example/authorize?state=${state}&redirect=${encodeURIComponent(redirectUri)}`,
  ),
  exchangeCode: vi.fn(async () => ({ access_token: 'mock-token' })),
  fetchUserinfo: vi.fn(async () => ({
    external_id: 'ext_123',
    email: 'alice@example.com',
    name: 'Alice',
    avatar_url: 'https://x/p.png',
  })),
});

const makeUsersDao = () => ({
  getById: vi.fn(async () => null),
  getTokenVersion: vi.fn(async () => 0),
  upsertByProvider: vi.fn(async () => ({ id: 'u_alice' })),
});

const makeApp = (providers: Record<string, OAuthProvider>, usersDao: any = makeUsersDao()) => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(buildOAuthRouter({
    usersDao,
    providers,
    sessionSecret: SECRET,
    cookieName: COOKIE_NAME,
    ttlHours: 24,
    publicBaseUrl: PUBLIC_BASE,
    frontendBaseUrl: FRONTEND_BASE,
  }));
  return { app, usersDao };
};

describe('oauth-router', () => {
  beforeEach(() => vi.restoreAllMocks());

  describe('GET /api/auth/:provider/start', () => {
    it('sets state cookie, 302 to provider auth URL with state + correct callback', async () => {
      const provider = makeMockProvider();
      const { app } = makeApp({ mock: provider });

      const res = await request(app).get('/api/auth/mock/start');

      expect(res.status).toBe(302);
      expect(res.headers['set-cookie']?.[0]).toMatch(new RegExp(`${STATE_COOKIE}=[a-f0-9]+`));
      const loc = res.headers['location']!;
      expect(loc).toContain('mock.example/authorize');
      expect(loc).toContain('state=');
      expect(loc).toContain(encodeURIComponent(`${PUBLIC_BASE}/api/auth/mock/callback`));
      const call = (provider.buildAuthUrl as any).mock.calls[0];
      expect(call[1]).toBe(`${PUBLIC_BASE}/api/auth/mock/callback`);
    });

    it('404 for unknown provider', async () => {
      const { app } = makeApp({});
      const res = await request(app).get('/api/auth/nonexistent/start');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/auth/:provider/callback', () => {
    it('happy path: exchange → fetch userinfo → upsert user → session cookie → 302 /desktop', async () => {
      const provider = makeMockProvider();
      const { app, usersDao } = makeApp({ mock: provider });

      const state = 'STATE_ABC';
      const res = await request(app)
        .get('/api/auth/mock/callback')
        .query({ code: 'the_code', state })
        .set('Cookie', `${STATE_COOKIE}=${state}`);

      expect(res.status).toBe(302);
      expect(res.headers['location']).toBe(`${FRONTEND_BASE}/desktop`);
      expect(provider.exchangeCode).toHaveBeenCalledWith('the_code', `${PUBLIC_BASE}/api/auth/mock/callback`);
      expect(provider.fetchUserinfo).toHaveBeenCalledWith('mock-token');
      expect(usersDao.upsertByProvider).toHaveBeenCalledWith('mock', expect.objectContaining({
        external_id: 'ext_123',
        email: 'alice@example.com',
      }));
      // session cookie set
      expect(res.headers['set-cookie']?.some((c: string) => c.startsWith(`${COOKIE_NAME}=`))).toBe(true);
      // state cookie cleared
      expect(res.headers['set-cookie']?.some((c: string) => c.startsWith(`${STATE_COOKIE}=;`))).toBe(true);
    });

    it('400 on state CSRF mismatch', async () => {
      const provider = makeMockProvider();
      const { app } = makeApp({ mock: provider });
      const res = await request(app)
        .get('/api/auth/mock/callback')
        .query({ code: 'c', state: 'A' })
        .set('Cookie', `${STATE_COOKIE}=B`);
      expect(res.status).toBe(400);
      expect(provider.exchangeCode).not.toHaveBeenCalled();
    });

    it('400 when state cookie missing', async () => {
      const provider = makeMockProvider();
      const { app } = makeApp({ mock: provider });
      const res = await request(app)
        .get('/api/auth/mock/callback')
        .query({ code: 'c', state: 'A' });
      expect(res.status).toBe(400);
    });

    it('400 on provider error (?error=access_denied) — no token exchange', async () => {
      const provider = makeMockProvider();
      const { app } = makeApp({ mock: provider });
      const res = await request(app)
        .get('/api/auth/mock/callback')
        .query({ error: 'access_denied', state: 'A' })
        .set('Cookie', `${STATE_COOKIE}=A`);
      expect(res.status).toBe(400);
      expect(provider.exchangeCode).not.toHaveBeenCalled();
    });

    it('404 for unknown provider', async () => {
      const { app } = makeApp({});
      const res = await request(app)
        .get('/api/auth/x/callback')
        .query({ code: 'c', state: 'A' })
        .set('Cookie', `${STATE_COOKIE}=A`);
      expect(res.status).toBe(404);
    });

    it('502 when exchangeCode throws', async () => {
      const provider = makeMockProvider();
      provider.exchangeCode = vi.fn(async () => { throw new Error('boom'); });
      const { app } = makeApp({ mock: provider });
      const res = await request(app)
        .get('/api/auth/mock/callback')
        .query({ code: 'c', state: 'A' })
        .set('Cookie', `${STATE_COOKIE}=A`);
      expect(res.status).toBe(502);
    });
  });
});
