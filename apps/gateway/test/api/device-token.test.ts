import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

import { dao } from '../../src/db/index.js';
import { buildDeviceTokenRouter } from '../../src/api/device-token.js';
import { verifyLaifuUserToken, TokenVersionMismatchError } from '../../src/lib/gateway-token.js';
import { mintHandoffCode } from '../../src/auth/desktop-handoff.js';
import { signSession } from '../../src/auth/session.js';
import { requireSession } from '../../src/auth/middleware.js';

const SECRET = 'test-secret-do-not-use-in-prod-123456';
const COOKIE_NAME = 'lingxi_sid';
const USER_ID = '6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f';

const validCookie = (userId: string): string => {
  const token = signSession({ user_id: userId }, SECRET, 24);
  return `${COOKIE_NAME}=${token}`;
};

const makeApp = () => {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  const mw = requireSession({ secret: SECRET, cookieName: COOKIE_NAME });
  app.use(buildDeviceTokenRouter({ sessionMw: mw, secret: SECRET }));
  return app;
};

describe('POST /api/auth/device-token', () => {
  it('mints a device JWT bound to the session user (version 0)', async () => {
    vi.mocked(dao.entitlements.getTokenVersion).mockResolvedValue(0);

    const res = await request(makeApp())
      .post('/api/auth/device-token')
      .set('Cookie', validCookie(USER_ID))
      .send({});

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.expires_at).toMatch(/T.*Z/);

    const verified = verifyLaifuUserToken(res.body.token, {
      expectedTokenVersion: 0,
      secret: SECRET,
    });
    expect(verified.userId).toBe(USER_ID);
  });

  it('binds the current token_version into the JWT (version 3)', async () => {
    vi.mocked(dao.entitlements.getTokenVersion).mockResolvedValue(3);

    const res = await request(makeApp())
      .post('/api/auth/device-token')
      .set('Cookie', validCookie(USER_ID))
      .send({});

    expect(res.status).toBe(200);

    // Verifying against the real version passes and yields the right user.
    const verified = verifyLaifuUserToken(res.body.token, {
      expectedTokenVersion: 3,
      secret: SECRET,
    });
    expect(verified.userId).toBe(USER_ID);
    expect(verified.tokenVersion).toBe(3);

    // Any other expected version must be rejected — proves the JWT actually
    // carries version 3, not a hard-coded default.
    expect(() =>
      verifyLaifuUserToken(res.body.token, { expectedTokenVersion: 0, secret: SECRET }),
    ).toThrow(TokenVersionMismatchError);
  });

  it('401 without a session cookie', async () => {
    const res = await request(makeApp()).post('/api/auth/device-token').send({});
    expect(res.status).toBe(401);
  });

  it('401 with a forged / malformed session cookie', async () => {
    const res = await request(makeApp())
      .post('/api/auth/device-token')
      .set('Cookie', `${COOKIE_NAME}=not.a.jwt`)
      .send({});
    expect(res.status).toBe(401);
  });

  it('401 "unknown user" when getTokenVersion returns null', async () => {
    vi.mocked(dao.entitlements.getTokenVersion).mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/auth/device-token')
      .set('Cookie', validCookie(USER_ID))
      .send({});

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unknown user');
  });

  it('500 when getTokenVersion throws', async () => {
    vi.mocked(dao.entitlements.getTokenVersion).mockRejectedValue(new Error('db down'));

    const res = await request(makeApp())
      .post('/api/auth/device-token')
      .set('Cookie', validCookie(USER_ID))
      .send({});

    expect(res.status).toBe(500);
  });
});

describe('POST /api/auth/device-token/exchange', () => {
  it('mints a device JWT from a valid handoff code (single use)', async () => {
    vi.mocked(dao.entitlements.getTokenVersion).mockResolvedValue(0);
    const code = mintHandoffCode(USER_ID);

    const res = await request(makeApp())
      .post('/api/auth/device-token/exchange')
      .send({ code });

    expect(res.status).toBe(200);
    const verified = verifyLaifuUserToken(res.body.token, { expectedTokenVersion: 0, secret: SECRET });
    expect(verified.userId).toBe(USER_ID);

    // Code is single-use: a second exchange with the same code must fail.
    const replay = await request(makeApp())
      .post('/api/auth/device-token/exchange')
      .send({ code });
    expect(replay.status).toBe(401);
  });

  it('401 for an unknown/forged code', async () => {
    const res = await request(makeApp())
      .post('/api/auth/device-token/exchange')
      .send({ code: 'not-a-real-code' });
    expect(res.status).toBe(401);
  });

  it('401 when code is missing from body', async () => {
    const res = await request(makeApp())
      .post('/api/auth/device-token/exchange')
      .send({});
    expect(res.status).toBe(401);
  });
});
