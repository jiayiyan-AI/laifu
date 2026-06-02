import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { makeContainerTokenMiddleware } from '../../src/auth/container-token.js';
import { signLaifuUserToken } from '../../src/lib/gateway-token.js';

const SECRET = 'test-secret-1234567890';
const USER_ID = '6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f';

function makeApp(tokenVersionFetcher: (userId: string) => Promise<number | null>) {
  const app = express();
  app.use(makeContainerTokenMiddleware({ secret: SECRET, tokenVersionFetcher }));
  app.get('/whoami', (req, res) => res.json({ user_id: (req as any).user_id }));
  return app;
}

describe('container-token middleware', () => {
  it('200 when token is valid and version matches', async () => {
    const fetcher = vi.fn().mockResolvedValue(0);
    const token = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: SECRET });
    const res = await request(makeApp(fetcher))
      .get('/whoami')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(USER_ID);
    expect(fetcher).toHaveBeenCalledWith(USER_ID);
  });

  it('401 when Authorization header missing', async () => {
    const res = await request(makeApp(vi.fn())).get('/whoami');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/missing|authorization/i);
  });

  it('401 when scheme is not Bearer', async () => {
    const res = await request(makeApp(vi.fn()))
      .get('/whoami')
      .set('Authorization', 'Basic abc');
    expect(res.status).toBe(401);
  });

  it('401 when token is invalid', async () => {
    const res = await request(makeApp(vi.fn()))
      .get('/whoami')
      .set('Authorization', 'Bearer not-a-jwt');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it('401 when user_id has no token_version row (deleted user)', async () => {
    const fetcher = vi.fn().mockResolvedValue(null);
    const token = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: SECRET });
    const res = await request(makeApp(fetcher))
      .get('/whoami')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/unknown|user/i);
  });

  it('401 when token_version mismatch (revoked)', async () => {
    const fetcher = vi.fn().mockResolvedValue(1);  // DB version is 1
    const token = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: SECRET }); // token has 0
    const res = await request(makeApp(fetcher))
      .get('/whoami')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/revoked|version/i);
  });
});
