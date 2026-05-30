import { describe, it, expect } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { requireSession } from '../../src/auth/middleware.js';
import { signSession } from '../../src/auth/session.js';

const SECRET = 'test-secret-do-not-use-in-prod-123456';
const COOKIE_NAME = 'lingxi_sid';

const makeApp = () => {
  const app = express();
  app.use(cookieParser());
  app.get('/protected', requireSession({ secret: SECRET, cookieName: COOKIE_NAME }), (req, res) => {
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
