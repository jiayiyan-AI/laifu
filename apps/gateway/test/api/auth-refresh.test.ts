import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

import { dao } from '../../src/db/index.js';
import { buildAuthRefreshRouter } from '../../src/api/auth-refresh.js';
import { signLaifuUserToken, verifyLaifuUserToken } from '../../src/lib/gateway-token.js';

const SECRET = 'test-secret-1234567890';
const USER_ID = '6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(buildAuthRefreshRouter({ secret: SECRET }));
  return app;
}

describe('POST /api/auth/refresh-token', () => {
  it('returns a fresh token when current token is valid', async () => {
    vi.mocked(dao.entitlements.getTokenVersion).mockResolvedValue(0);
    const old = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: SECRET });
    const res = await request(makeApp())
      .post('/api/auth/refresh-token')
      .set('Authorization', `Bearer ${old}`)
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

  it('accepts a token expired within 7 days (grace)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const old = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: SECRET });
    vi.setSystemTime(new Date('2026-04-06T00:00:00Z'));

    vi.mocked(dao.entitlements.getTokenVersion).mockResolvedValue(0);
    const res = await request(makeApp())
      .post('/api/auth/refresh-token')
      .set('Authorization', `Bearer ${old}`)
      .send({});
    expect(res.status).toBe(200);
    vi.useRealTimers();
  });

  it('rejects a token expired >7 days', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const old = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: SECRET });
    vi.setSystemTime(new Date('2026-04-09T00:00:00Z'));

    vi.mocked(dao.entitlements.getTokenVersion).mockResolvedValue(0);
    const res = await request(makeApp())
      .post('/api/auth/refresh-token')
      .set('Authorization', `Bearer ${old}`)
      .send({});
    expect(res.status).toBe(401);
    vi.useRealTimers();
  });

  it('rejects when token_version was bumped (revoked) — even within grace', async () => {
    vi.mocked(dao.entitlements.getTokenVersion).mockResolvedValue(1);
    const old = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: SECRET });
    const res = await request(makeApp())
      .post('/api/auth/refresh-token')
      .set('Authorization', `Bearer ${old}`)
      .send({});
    expect(res.status).toBe(401);
  });

  it('401 without Authorization header', async () => {
    const res = await request(makeApp()).post('/api/auth/refresh-token').send({});
    expect(res.status).toBe(401);
  });
});
