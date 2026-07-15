import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import type { OAuthProvider } from '../../src/auth/providers/types.js';
import { signSession } from '../../src/auth/session.js';
import { redeemHandoffCode } from '../../src/auth/desktop-handoff.js';

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

import { dao } from '../../src/db/index.js';
import { buildOAuthRouter } from '../../src/auth/oauth-router.js';

const SECRET = 'test-secret-do-not-use-in-prod-1234567';
const COOKIE_NAME = 'lingxi_sid';
const STATE_COOKIE = 'lingxi_oauth_state';
const PUBLIC_BASE = 'http://localhost:9000';
const FRONTEND_BASE = 'http://localhost:3000';
const DESKTOP_COOKIE = 'lingxi_oauth_desktop';

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

const makeApp = (providers: Record<string, OAuthProvider>) => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(buildOAuthRouter({
    providers,
    sessionSecret: SECRET,
    cookieName: COOKIE_NAME,
    ttlHours: 24,
    publicBaseUrl: PUBLIC_BASE,
    frontendBaseUrl: FRONTEND_BASE,
  }));
  return app;
};

describe('oauth-router', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(dao.users.upsertByProvider).mockResolvedValue({ id: 'u_alice' });
  });

  describe('GET /api/auth/:provider/start', () => {
    it('sets state cookie, 302 to provider auth URL with state + correct callback', async () => {
      const provider = makeMockProvider();
      const app = makeApp({ mock: provider });

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
      const app = makeApp({});
      const res = await request(app).get('/api/auth/nonexistent/start');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/auth/:provider/callback', () => {
    it('happy path: exchange → fetch userinfo → upsert user → session cookie → 302 /desktop', async () => {
      const provider = makeMockProvider();
      const app = makeApp({ mock: provider });

      const state = 'STATE_ABC';
      const res = await request(app)
        .get('/api/auth/mock/callback')
        .query({ code: 'the_code', state })
        .set('Cookie', `${STATE_COOKIE}=${state}`);

      expect(res.status).toBe(302);
      expect(res.headers['location']).toBe(`${FRONTEND_BASE}/desktop`);
      expect(provider.exchangeCode).toHaveBeenCalledWith('the_code', `${PUBLIC_BASE}/api/auth/mock/callback`);
      expect(provider.fetchUserinfo).toHaveBeenCalledWith('mock-token');
      expect(dao.users.upsertByProvider).toHaveBeenCalledWith('mock', expect.objectContaining({
        external_id: 'ext_123',
        email: 'alice@example.com',
      }));
      expect(res.headers['set-cookie']?.some((c: string) => c.startsWith(`${COOKIE_NAME}=`))).toBe(true);
      expect(res.headers['set-cookie']?.some((c: string) => c.startsWith(`${STATE_COOKIE}=;`))).toBe(true);
    });

    it('400 on state CSRF mismatch', async () => {
      const provider = makeMockProvider();
      const app = makeApp({ mock: provider });
      const res = await request(app)
        .get('/api/auth/mock/callback')
        .query({ code: 'c', state: 'A' })
        .set('Cookie', `${STATE_COOKIE}=B`);
      expect(res.status).toBe(400);
      expect(provider.exchangeCode).not.toHaveBeenCalled();
    });

    it('400 when state cookie missing', async () => {
      const provider = makeMockProvider();
      const app = makeApp({ mock: provider });
      const res = await request(app)
        .get('/api/auth/mock/callback')
        .query({ code: 'c', state: 'A' });
      expect(res.status).toBe(400);
    });

    it('400 on provider error (?error=access_denied) — no token exchange', async () => {
      const provider = makeMockProvider();
      const app = makeApp({ mock: provider });
      const res = await request(app)
        .get('/api/auth/mock/callback')
        .query({ error: 'access_denied', state: 'A' })
        .set('Cookie', `${STATE_COOKIE}=A`);
      expect(res.status).toBe(400);
      expect(provider.exchangeCode).not.toHaveBeenCalled();
    });

    it('404 for unknown provider', async () => {
      const app = makeApp({});
      const res = await request(app)
        .get('/api/auth/x/callback')
        .query({ code: 'c', state: 'A' })
        .set('Cookie', `${STATE_COOKIE}=A`);
      expect(res.status).toBe(404);
    });

    it('502 when exchangeCode throws', async () => {
      const provider = makeMockProvider();
      provider.exchangeCode = vi.fn(async () => { throw new Error('boom'); });
      const app = makeApp({ mock: provider });
      const res = await request(app)
        .get('/api/auth/mock/callback')
        .query({ code: 'c', state: 'A' })
        .set('Cookie', `${STATE_COOKIE}=A`);
      expect(res.status).toBe(502);
    });
  });

  describe('desktop system-browser OAuth (?client=desktop)', () => {
    it('start sets desktop cookie (channel value) alongside state cookie', async () => {
      const provider = makeMockProvider();
      const app = makeApp({ mock: provider });
      const res = await request(app).get('/api/auth/mock/start').query({ client: 'desktop', channel: 'canary' });
      expect(res.status).toBe(302);
      const setCookies = res.headers['set-cookie'] as unknown as string[];
      expect(setCookies.some((c) => c.startsWith(`${STATE_COOKIE}=`))).toBe(true);
      expect(setCookies.some((c) => c.startsWith(`${DESKTOP_COOKIE}=canary`))).toBe(true);
    });

    it('start with ?client=desktop but no/invalid channel falls back to stable', async () => {
      const provider = makeMockProvider();
      const app = makeApp({ mock: provider });
      const res = await request(app).get('/api/auth/mock/start').query({ client: 'desktop' });
      const setCookies = res.headers['set-cookie'] as unknown as string[];
      expect(setCookies.some((c) => c.startsWith(`${DESKTOP_COOKIE}=stable`))).toBe(true);
    });

    it('start without ?client=desktop does not set desktop cookie', async () => {
      const provider = makeMockProvider();
      const app = makeApp({ mock: provider });
      const res = await request(app).get('/api/auth/mock/start');
      const setCookies = res.headers['set-cookie'] as unknown as string[];
      expect(setCookies.some((c) => c.startsWith(`${DESKTOP_COOKIE}=`))).toBe(false);
    });

    it('callback redirects to frontend bridge page with a handoff code, no session cookie', async () => {
      const provider = makeMockProvider();
      const app = makeApp({ mock: provider });
      const state = 'STATE_XYZ';
      const res = await request(app)
        .get('/api/auth/mock/callback')
        .query({ code: 'the_code', state })
        .set('Cookie', [`${STATE_COOKIE}=${state}`, `${DESKTOP_COOKIE}=1`]);

      expect(res.status).toBe(302);
      expect(res.headers['location']).toMatch(new RegExp(`^${FRONTEND_BASE}/desktop-oauth-complete\\?code=[a-f0-9]+&channel=stable$`));
      expect(res.headers['set-cookie']?.some((c: string) => c.startsWith(`${COOKIE_NAME}=`))).toBe(false);
      const setCookies = res.headers['set-cookie'] as unknown as string[];
      expect(setCookies.some((c) => c.startsWith(`${DESKTOP_COOKIE}=;`))).toBe(true);
    });

    it.each(['dev', 'canary'] as const)('callback preserves the %s desktop channel', async (channel) => {
      const provider = makeMockProvider();
      const app = makeApp({ mock: provider });
      const state = `STATE_${channel}`;
      const res = await request(app)
        .get('/api/auth/mock/callback')
        .query({ code: 'the_code', state })
        .set('Cookie', [`${STATE_COOKIE}=${state}`, `${DESKTOP_COOKIE}=${channel}`]);

      expect(res.status).toBe(302);
      expect(res.headers['location']).toMatch(
        new RegExp(`^${FRONTEND_BASE}/desktop-oauth-complete\\?code=[a-f0-9]+&channel=${channel}$`),
      );
      expect(res.headers['set-cookie']?.some((c: string) => c.startsWith(`${COOKIE_NAME}=`))).toBe(false);
    });

    it('callback ignores a malformed desktop cookie and completes normal web OAuth', async () => {
      const provider = makeMockProvider();
      const app = makeApp({ mock: provider });
      const state = 'STATE_MALFORMED_DESKTOP_COOKIE';
      const res = await request(app)
        .get('/api/auth/mock/callback')
        .query({ code: 'the_code', state })
        .set('Cookie', [`${STATE_COOKIE}=${state}`, `${DESKTOP_COOKIE}=unexpected`]);

      expect(res.status).toBe(302);
      expect(res.headers['location']).toBe(`${FRONTEND_BASE}/desktop`);
      expect(res.headers['set-cookie']?.some((c: string) => c.startsWith(`${COOKIE_NAME}=`))).toBe(true);
    });

    it('reuses an existing valid session cookie: skips Google entirely, mints handoff code directly', async () => {
      const provider = makeMockProvider();
      const app = makeApp({ mock: provider });
      const existingSession = signSession({ user_id: 'u_already_logged_in' }, SECRET, 24);

      const res = await request(app)
        .get('/api/auth/mock/start')
        .query({ client: 'desktop', channel: 'canary' })
        .set('Cookie', `${COOKIE_NAME}=${existingSession}`);

      expect(res.status).toBe(302);
      expect(provider.buildAuthUrl).not.toHaveBeenCalled();
      const match = res.headers['location']!.match(/\/desktop-oauth-complete\?code=([a-f0-9]+)&channel=canary$/);
      expect(match).not.toBeNull();
      expect(redeemHandoffCode(match![1]!)).toBe('u_already_logged_in');
    });

    it('falls back to normal OAuth flow when the session cookie is invalid/expired', async () => {
      const provider = makeMockProvider();
      const app = makeApp({ mock: provider });

      const res = await request(app)
        .get('/api/auth/mock/start')
        .query({ client: 'desktop' })
        .set('Cookie', `${COOKIE_NAME}=not.a.valid.jwt`);

      expect(res.status).toBe(302);
      expect(res.headers['location']).toContain('mock.example/authorize');
      expect(provider.buildAuthUrl).toHaveBeenCalled();
    });

    it('normal (non-desktop) start ignores any existing session cookie — always goes to Google', async () => {
      const provider = makeMockProvider();
      const app = makeApp({ mock: provider });
      const existingSession = signSession({ user_id: 'u_already_logged_in' }, SECRET, 24);

      const res = await request(app)
        .get('/api/auth/mock/start')
        .set('Cookie', `${COOKIE_NAME}=${existingSession}`);

      expect(res.status).toBe(302);
      expect(res.headers['location']).toContain('mock.example/authorize');
    });
  });
});
