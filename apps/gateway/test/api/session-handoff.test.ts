import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

import { dao } from '../../src/db/index.js';
import { buildSessionHandoffRouter } from '../../src/api/session-handoff.js';
import { signLaifuUserToken } from '../../src/lib/gateway-token.js';
import { verifySession } from '../../src/auth/session.js';
import { mintHandoffCode } from '../../src/auth/desktop-handoff.js';

const DEVICE_SECRET = 'device-secret-1234567890';
const SESSION_SECRET = 'session-secret-0987654321';
const COOKIE_NAME = 'lingxi_sid';
const FRONTEND_BASE = 'http://localhost:3000';
const USER_ID = '6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f';

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(buildSessionHandoffRouter({
    deviceTokenSecret: DEVICE_SECRET,
    sessionSecret: SESSION_SECRET,
    cookieName: COOKIE_NAME,
    ttlHours: 168,
    frontendBaseUrl: FRONTEND_BASE,
  }));
  return app;
};

describe('POST /api/auth/session-code', () => {
  it('mints a one-time code for a valid device JWT', async () => {
    vi.mocked(dao.entitlements.getTokenVersion).mockResolvedValue(0);
    const jwt = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: DEVICE_SECRET });

    const res = await request(makeApp())
      .post('/api/auth/session-code')
      .set('Authorization', `Bearer ${jwt}`);

    expect(res.status).toBe(200);
    expect(typeof res.body.code).toBe('string');
    expect(res.body.code.length).toBeGreaterThan(20);
  });

  it('401 without Authorization header', async () => {
    const res = await request(makeApp()).post('/api/auth/session-code');
    expect(res.status).toBe(401);
  });

  it('401 when device JWT is revoked (token_version mismatch)', async () => {
    vi.mocked(dao.entitlements.getTokenVersion).mockResolvedValue(1);
    const jwt = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: DEVICE_SECRET });

    const res = await request(makeApp())
      .post('/api/auth/session-code')
      .set('Authorization', `Bearer ${jwt}`);

    expect(res.status).toBe(401);
  });

  it('401 "unknown user" when getTokenVersion returns null', async () => {
    vi.mocked(dao.entitlements.getTokenVersion).mockResolvedValue(null);
    const jwt = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: DEVICE_SECRET });

    const res = await request(makeApp())
      .post('/api/auth/session-code')
      .set('Authorization', `Bearer ${jwt}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unknown user');
  });
});

describe('GET /api/auth/session-from-code', () => {
  it('redeems a valid code: sets session cookie, redirects to /desktop', async () => {
    const code = mintHandoffCode(USER_ID);

    const res = await request(makeApp())
      .get('/api/auth/session-from-code')
      .query({ code });

    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe(`${FRONTEND_BASE}/desktop`);
    const setCookie = res.headers['set-cookie']?.find((c: string) => c.startsWith(`${COOKIE_NAME}=`));
    expect(setCookie).toBeDefined();
    const token = setCookie!.split(';')[0]!.split('=')[1]!;
    expect(verifySession(token, SESSION_SECRET).user_id).toBe(USER_ID);
  });

  it('code is single-use: replay fails', async () => {
    const code = mintHandoffCode(USER_ID);
    await request(makeApp()).get('/api/auth/session-from-code').query({ code });

    const replay = await request(makeApp()).get('/api/auth/session-from-code').query({ code });
    expect(replay.status).toBe(401);
  });

  it('401 for an unknown/forged code', async () => {
    const res = await request(makeApp()).get('/api/auth/session-from-code').query({ code: 'bogus' });
    expect(res.status).toBe(401);
  });

  it('401 when code query param missing', async () => {
    const res = await request(makeApp()).get('/api/auth/session-from-code');
    expect(res.status).toBe(401);
  });
});
