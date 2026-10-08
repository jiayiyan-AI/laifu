import { describe, it, expect } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { requireSession } from '../../src/auth/middleware.js';
import { signSession } from '../../src/auth/session.js';
import { makeSessionVersionStore } from '../../src/auth/session-version.js';

const SECRET = 'test-secret-do-not-use-in-prod-123456';
const COOKIE_NAME = 'lingxi_sid';

const makeApp = (versions?: ReturnType<typeof makeSessionVersionStore>) => {
  const app = express();
  app.use(cookieParser());
  app.get('/protected', requireSession({ secret: SECRET, cookieName: COOKIE_NAME, versions }), (req, res) => {
    const user = (req as any).session;
    res.json({ user_id: user.user_id });
  });
  return app;
};

describe('requireSession', () => {
  it('401 when no cookie', async () => {
    const res = await request(makeApp()).get('/protected');
    expect(res.status).toBe(401);
  });

  it('401 when cookie has invalid JWT', async () => {
    const res = await request(makeApp())
      .get('/protected')
      .set('Cookie', `${COOKIE_NAME}=this.is.not.a.jwt`);
    expect(res.status).toBe(401);
  });

  it('passes through and exposes req.session.user_id when cookie is valid', async () => {
    const token = signSession({ user_id: 'u1' }, SECRET, 24);
    const res = await request(makeApp())
      .get('/protected')
      .set('Cookie', `${COOKIE_NAME}=${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe('u1');
  });
});

describe('requireSession + session_version', () => {
  const storeOf = (v: number | null | Error) =>
    makeSessionVersionStore(async () => { if (v instanceof Error) throw v; return v; });

  it('无 sv 的老 JWT 在 session_version=0 时通过(上线不踢人)', async () => {
    const token = signSession({ user_id: 'u1' }, SECRET, 24);
    const res = await request(makeApp(storeOf(0))).get('/protected').set('Cookie', `${COOKIE_NAME}=${token}`);
    expect(res.status).toBe(200);
  });

  it('无 sv 的老 JWT 在 session_version=1 时被拒', async () => {
    const token = signSession({ user_id: 'u1' }, SECRET, 24);
    const res = await request(makeApp(storeOf(1))).get('/protected').set('Cookie', `${COOKIE_NAME}=${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('session revoked');
  });

  it('sv 一致通过, 不一致 401', async () => {
    const ok = signSession({ user_id: 'u1', sv: 2 }, SECRET, 24);
    const bad = signSession({ user_id: 'u1', sv: 1 }, SECRET, 24);
    expect((await request(makeApp(storeOf(2))).get('/protected').set('Cookie', `${COOKIE_NAME}=${ok}`)).status).toBe(200);
    expect((await request(makeApp(storeOf(2))).get('/protected').set('Cookie', `${COOKIE_NAME}=${bad}`)).status).toBe(401);
  });

  it('用户不存在 → 401', async () => {
    const token = signSession({ user_id: 'gone', sv: 0 }, SECRET, 24);
    const res = await request(makeApp(storeOf(null))).get('/protected').set('Cookie', `${COOKIE_NAME}=${token}`);
    expect(res.status).toBe(401);
  });

  it('查库抛错 → 放行(fail-open, 不因 DB 抖动全站 401)', async () => {
    const token = signSession({ user_id: 'u1', sv: 5 }, SECRET, 24);
    const res = await request(makeApp(storeOf(new Error('db down')))).get('/protected').set('Cookie', `${COOKIE_NAME}=${token}`);
    expect(res.status).toBe(200);
  });
});
