import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { buildMeEntitlementsRouter } from '../../src/api/me-entitlements.js';
import { signLaifuUserToken } from '../../src/lib/gateway-token.js';

const SECRET = 'test-secret-1234567890';
const USER_ID = '6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f';

function makeApp(opts: {
  listActive: (userId: string) => Promise<string[]>;
  upsertObserved: (input: any) => Promise<void>;
  getTokenVersion: (userId: string) => Promise<number | null>;
}) {
  const app = express();
  app.use(express.json());
  app.use(buildMeEntitlementsRouter({
    secret: SECRET,
    entitlements: { listActive: opts.listActive, getTokenVersion: opts.getTokenVersion } as any,
    observedState: { upsert: opts.upsertObserved } as any,
  }));
  return app;
}

describe('GET /api/me/entitlements', () => {
  it('returns active entitlements + token_version for the authenticated container', async () => {
    const app = makeApp({
      listActive: vi.fn().mockResolvedValue(['cloud']),
      upsertObserved: vi.fn(),
      getTokenVersion: vi.fn().mockResolvedValue(2),
    });
    const token = signLaifuUserToken({ userId: USER_ID, tokenVersion: 2, secret: SECRET });
    const res = await request(app)
      .get('/api/me/entitlements')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ entitlements: ['cloud'], token_version: 2 });
  });

  it('401 without token', async () => {
    const app = makeApp({
      listActive: vi.fn(),
      upsertObserved: vi.fn(),
      getTokenVersion: vi.fn(),
    });
    const res = await request(app).get('/api/me/entitlements');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/me/observed-entitlements', () => {
  it('writes observed state for the authenticated container', async () => {
    const upsert = vi.fn().mockResolvedValue(undefined);
    const app = makeApp({
      listActive: vi.fn().mockResolvedValue(['cloud']),
      upsertObserved: upsert,
      getTokenVersion: vi.fn().mockResolvedValue(0),
    });
    const token = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: SECRET });
    const res = await request(app)
      .post('/api/me/observed-entitlements')
      .set('Authorization', `Bearer ${token}`)
      .send({ observed: ['cloud'], token_version: 0 });
    expect(res.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith({
      user_id: USER_ID,
      observed_entitlements: ['cloud'],
      observed_token_version: 0,
    });
  });

  it('400 on missing fields', async () => {
    const app = makeApp({
      listActive: vi.fn(),
      upsertObserved: vi.fn(),
      getTokenVersion: vi.fn().mockResolvedValue(0),
    });
    const token = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: SECRET });
    const res = await request(app)
      .post('/api/me/observed-entitlements')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });
});
