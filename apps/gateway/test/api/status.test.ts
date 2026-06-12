import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { RequestHandler } from 'express';

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

import { dao } from '../../src/db/index.js';
import { buildStatusRouter } from '../../src/api/status.js';

const USER_ID = '6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f';

function mockSession(): RequestHandler {
  return (req, _res, next) => { (req as any).session = { user_id: USER_ID }; next(); };
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(buildStatusRouter(mockSession()));
  return app;
}

describe('GET /api/status', () => {
  it('returns provisioning fields + entitlements + observed when DAOs provided', async () => {
    vi.mocked(dao.cache.get).mockReturnValue({
      status: 'ready', provisioning_step: '...', progress_pct: 100, error_message: null,
    } as any);
    vi.mocked(dao.entitlements.listActive).mockResolvedValue(['cloud']);
    vi.mocked(dao.entitlements.getTokenVersion).mockResolvedValue(1);
    vi.mocked(dao.observedState.get).mockResolvedValue({
      user_id: USER_ID,
      observed_entitlements: ['cloud'],
      observed_token_version: 1,
    });

    const res = await request(makeApp()).get('/api/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ready',
      entitlements_desired: ['cloud'],
      entitlements_observed: ['cloud'],
      container_token_version: 1,
    });
  });

  it('observed defaults to [] when container never reported', async () => {
    vi.mocked(dao.cache.get).mockReturnValue({
      status: 'ready', provisioning_step: null, progress_pct: 100, error_message: null,
    } as any);
    vi.mocked(dao.entitlements.listActive).mockResolvedValue(['cloud']);
    vi.mocked(dao.entitlements.getTokenVersion).mockResolvedValue(0);
    vi.mocked(dao.observedState.get).mockResolvedValue(null);

    const res = await request(makeApp()).get('/api/status');
    expect(res.body.entitlements_observed).toEqual([]);
  });

  it('404 when no container mapping exists', async () => {
    vi.mocked(dao.cache.get).mockReturnValue(null);

    const res = await request(makeApp()).get('/api/status');
    expect(res.status).toBe(404);
  });

  it('backwards-compat: omits entitlements fields if DAOs not passed', async () => {
    // Now DAOs are always available via the module, so this test just verifies
    // that the endpoint still returns the base fields when entitlements are empty
    vi.mocked(dao.cache.get).mockReturnValue({
      status: 'ready', provisioning_step: null, progress_pct: 100, error_message: null,
    } as any);
    vi.mocked(dao.entitlements.listActive).mockResolvedValue([]);
    vi.mocked(dao.entitlements.getTokenVersion).mockResolvedValue(0);
    vi.mocked(dao.observedState.get).mockResolvedValue(null);

    const res = await request(makeApp()).get('/api/status');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
  });
});
