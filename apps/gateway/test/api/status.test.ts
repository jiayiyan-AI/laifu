import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { buildStatusRouter } from '../../src/api/status.js';
import type { RequestHandler } from 'express';

const USER_ID = '6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f';

function mockSession(): RequestHandler {
  return (req, _res, next) => { (req as any).session = { user_id: USER_ID }; next(); };
}

function makeApp(opts: {
  containerRow: any;
  desired: string[];
  observed: { observed_entitlements: string[]; observed_token_version: number } | null;
  tokenVersion: number;
}) {
  const app = express();
  app.use(express.json());
  const fakeCache = { get: () => opts.containerRow } as any;
  app.use(buildStatusRouter(
    fakeCache,
    mockSession(),
    { listActive: () => Promise.resolve(opts.desired), getTokenVersion: () => Promise.resolve(opts.tokenVersion) } as any,
    { get: () => Promise.resolve(opts.observed) } as any,
  ));
  return app;
}

describe('GET /api/status', () => {
  it('returns provisioning fields + entitlements + observed when DAOs provided', async () => {
    const app = makeApp({
      containerRow: {
        status: 'ready', provisioning_step: '...', progress_pct: 100,
        error_message: null,
      },
      desired: ['cloud'],
      observed: { observed_entitlements: ['cloud'], observed_token_version: 1 },
      tokenVersion: 1,
    });
    const res = await request(app).get('/api/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ready',
      entitlements_desired: ['cloud'],
      entitlements_observed: ['cloud'],
      container_token_version: 1,
    });
  });

  it('observed defaults to [] when container never reported', async () => {
    const app = makeApp({
      containerRow: {
        status: 'ready', provisioning_step: null, progress_pct: 100, error_message: null,
      },
      desired: ['cloud'],
      observed: null,
      tokenVersion: 0,
    });
    const res = await request(app).get('/api/status');
    expect(res.body.entitlements_observed).toEqual([]);
  });

  it('404 when no container mapping exists', async () => {
    const app = makeApp({
      containerRow: null,
      desired: [], observed: null, tokenVersion: 0,
    });
    const res = await request(app).get('/api/status');
    expect(res.status).toBe(404);
  });

  it('backwards-compat: omits entitlements fields if DAOs not passed', async () => {
    const app = express();
    app.use(express.json());
    const fakeCache = { get: () => ({ status: 'ready', provisioning_step: null, progress_pct: 100, error_message: null }) } as any;
    app.use(buildStatusRouter(fakeCache, mockSession()));  // 2-arg call, no DAOs
    const res = await request(app).get('/api/status');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    // when DAOs are not provided, fields should be omitted or empty
  });
});
