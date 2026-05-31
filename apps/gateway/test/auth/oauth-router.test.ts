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

const makeSb = (existing: any = null) => {
  const sb: any = {
    from: vi.fn(() => sb),
    upsert: vi.fn(() => sb),
    select: vi.fn(() => sb),
    eq: vi.fn(() => sb),
    single: vi.fn(() => Promise.resolve({
      data: existing ?? {
        id: 'u_alice',
        provider: 'mock',
        external_id: 'ext_123',
        email: 'alice@example.com',
        nickname: 'Alice',
        avatar_url: 'https://x/p.png',
      },
      error: null,
    })),
  };
  return sb;
};

const makeApp = (providers: Record<string, OAuthProvider>, sb: any = makeSb()) => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(buildOAuthRouter({
    sb,
    providers,
    sessionSecret: SECRET,
    cookieName: COOKIE_NAME,
    ttlHours: 24,
    publicBaseUrl: PUBLIC_BASE,
  }));
  return { app, sb };
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
      // state captured into the redirect URL
      const loc = res.headers['location']!;
      expect(loc).toContain('mock.example/authorize');
      expect(loc).toContain('state=');
      // redirect_uri must be /api/auth/<provider>/callback under publicBaseUrl
      expect(loc).toContain(encodeURIComponent(`${PUBLIC_BASE}/api/auth/mock/callback`));
      // buildAuthUrl received both
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
      const { app, sb } = makeApp({ mock: provider });

      // simulate state cookie set by /start
      const state = 'STATE_ABC';
      const res = await request(app)
        .get('/api/auth/mock/callback')
        .query({ code: 'the_code', state })
        .set('Cookie', `${STATE_COOKIE}=${state}`);

      expect(res.status).toBe(302);
      expect(res.headers['location']).toBe('/desktop');
      expect(provider.exchangeCode).toHaveBeenCalledWith('the_code', `${PUBLIC_BASE}/api/auth/mock/callback`);
      expect(provider.fetchUserinfo).toHaveBeenCalledWith('mock-token');
      // upsert call shape
      expect(sb.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'mock',
          external_id: 'ext_123',
          email: 'alice@example.com',
        }),
        { onConflict: 'provider,external_id' },
      );
      // session cookie set
      expect(res.headers['set-cookie']?.some((c) => c.startsWith(`${COOKIE_NAME}=`))).toBe(true);
      // state cookie cleared
      expect(res.headers['set-cookie']?.some((c) => c.startsWith(`${STATE_COOKIE}=;`))).toBe(true);
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
