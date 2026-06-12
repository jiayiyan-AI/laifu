import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

import { dao } from '../../src/db/index.js';
import { buildMeEntitlementsRouter } from '../../src/api/me-entitlements.js';
import { signLaifuUserToken } from '../../src/lib/gateway-token.js';

const SECRET = 'test-secret-1234567890';
const USER_ID = '6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(buildMeEntitlementsRouter({ secret: SECRET }));
  return app;
}

describe('GET /api/me/entitlements', () => {
  it('returns active entitlements + token_version for the authenticated container', async () => {
    vi.mocked(dao.entitlements.listActive).mockResolvedValue(['cloud']);
    vi.mocked(dao.entitlements.getTokenVersion).mockResolvedValue(2);
    const token = signLaifuUserToken({ userId: USER_ID, tokenVersion: 2, secret: SECRET });
    const res = await request(makeApp())
      .get('/api/me/entitlements')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ entitlements: ['cloud'], token_version: 2 });
  });

  it('401 without token', async () => {
    const res = await request(makeApp()).get('/api/me/entitlements');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/me/observed-entitlements', () => {
  it('writes observed state for the authenticated container', async () => {
    vi.mocked(dao.entitlements.getTokenVersion).mockResolvedValue(0);
    const token = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: SECRET });
    const res = await request(makeApp())
      .post('/api/me/observed-entitlements')
      .set('Authorization', `Bearer ${token}`)
      .send({ observed: ['cloud'], token_version: 0 });
    expect(res.status).toBe(200);
    expect(dao.observedState.upsert).toHaveBeenCalledWith({
      user_id: USER_ID,
      observed_entitlements: ['cloud'],
      observed_token_version: 0,
    });
  });

  it('400 on missing fields', async () => {
    vi.mocked(dao.entitlements.getTokenVersion).mockResolvedValue(0);
    const token = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: SECRET });
    const res = await request(makeApp())
      .post('/api/me/observed-entitlements')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });
});
