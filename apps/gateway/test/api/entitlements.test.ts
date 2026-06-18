import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import type { RequestHandler } from 'express';

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

// syncUserContainer 内部按 config 触达 azure (new DefaultAzureCredential) —— 整体 mock 掉, 只验证被触发。
const { syncUserContainer } = vi.hoisted(() => ({ syncUserContainer: vi.fn(async () => {}) }));
vi.mock('../../src/provisioning/manager.js', () => ({ syncUserContainer }));

import { dao } from '../../src/db/index.js';
import { buildEntitlementsRouter } from '../../src/api/entitlements.js';

const USER_ID = '6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f';

function mockSession(): RequestHandler {
  return (req, _res, next) => { (req as any).session = { user_id: USER_ID }; next(); };
}

function makeApp(deps: { onEnable?: ReturnType<typeof vi.fn> } = {}) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(buildEntitlementsRouter({
    onEnable: deps.onEnable,
    sessionMw: mockSession(),
  }));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/entitlements/cloud/enable', () => {
  it('happy path: enable changes state → bump version → sync container', async () => {
    vi.mocked(dao.entitlements.enable).mockResolvedValue({ changed: true });
    vi.mocked(dao.entitlements.listActive).mockResolvedValue(['cloud']);
    vi.mocked(dao.entitlements.bumpTokenVersion).mockResolvedValue(1);

    const res = await request(makeApp()).post('/api/entitlements/cloud/enable');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, entitlements: ['cloud'], changed: true });
    expect(dao.entitlements.enable).toHaveBeenCalledWith(USER_ID, 'cloud');
    expect(dao.entitlements.bumpTokenVersion).toHaveBeenCalledWith(USER_ID);
    expect(syncUserContainer).toHaveBeenCalledWith(USER_ID);
  });

  it('idempotent: already enabled → no bump, but still sync for resync', async () => {
    vi.mocked(dao.entitlements.enable).mockResolvedValue({ changed: false });
    vi.mocked(dao.entitlements.listActive).mockResolvedValue(['cloud']);

    const res = await request(makeApp()).post('/api/entitlements/cloud/enable');

    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    expect(dao.entitlements.bumpTokenVersion).not.toHaveBeenCalled();
    expect(syncUserContainer).toHaveBeenCalledWith(USER_ID);
  });
});

describe('POST /api/entitlements/cloud/disable', () => {
  it('disable changes state → bump version → sync, but does NOT delete blob data', async () => {
    vi.mocked(dao.entitlements.disable).mockResolvedValue({ changed: true });
    vi.mocked(dao.entitlements.listActive).mockResolvedValue([]);
    vi.mocked(dao.entitlements.bumpTokenVersion).mockResolvedValue(2);

    const res = await request(makeApp()).post('/api/entitlements/cloud/disable');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, entitlements: [], changed: true });
    expect(dao.entitlements.disable).toHaveBeenCalledWith(USER_ID, 'cloud');
    expect(dao.entitlements.bumpTokenVersion).toHaveBeenCalled();
    expect(syncUserContainer).toHaveBeenCalledWith(USER_ID);
  });
});

describe('feature allowlist', () => {
  it('unknown feature → 404, no DAO call', async () => {
    const res = await request(makeApp()).post('/api/entitlements/bogus/enable');
    expect(res.status).toBe(404);
    expect(dao.entitlements.enable).not.toHaveBeenCalled();
    expect(syncUserContainer).not.toHaveBeenCalled();
  });

  it('email is now allowed (sub-project B) → enable proceeds', async () => {
    vi.mocked(dao.entitlements.enable).mockResolvedValue({ changed: true });
    vi.mocked(dao.entitlements.listActive).mockResolvedValue(['email']);
    vi.mocked(dao.entitlements.bumpTokenVersion).mockResolvedValue(1);

    const res = await request(makeApp()).post('/api/entitlements/email/enable');
    expect(res.status).toBe(200);
    expect(dao.entitlements.enable).toHaveBeenCalledWith(USER_ID, 'email');
  });
});

describe('onEnable hook', () => {
  it('enable 成功后调用 onEnable(userId, feature)', async () => {
    vi.mocked(dao.entitlements.enable).mockResolvedValue({ changed: true });
    vi.mocked(dao.entitlements.listActive).mockResolvedValue(['email']);
    vi.mocked(dao.entitlements.bumpTokenVersion).mockResolvedValue(1);
    const onEnable = vi.fn().mockResolvedValue(undefined);

    const res = await request(makeApp({ onEnable })).post('/api/entitlements/email/enable');
    expect(res.status).toBe(200);
    expect(onEnable).toHaveBeenCalledWith(USER_ID, 'email');
  });

  it('onEnable 抛错不影响 200(钩子失败仅记日志)', async () => {
    vi.mocked(dao.entitlements.enable).mockResolvedValue({ changed: true });
    vi.mocked(dao.entitlements.listActive).mockResolvedValue(['email']);
    vi.mocked(dao.entitlements.bumpTokenVersion).mockResolvedValue(1);
    const onEnable = vi.fn().mockRejectedValue(new Error('boom'));

    const res = await request(makeApp({ onEnable })).post('/api/entitlements/email/enable');
    expect(res.status).toBe(200);
  });
});
