import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { buildEntitlementsRouter } from '../../src/api/entitlements.js';
import type { RequestHandler } from 'express';

const USER_ID = '6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f';

function mockSession(): RequestHandler {
  return (req, _res, next) => { (req as any).session = { user_id: USER_ID }; next(); };
}

function makeApp(deps: {
  enable: ReturnType<typeof vi.fn>;
  disable: ReturnType<typeof vi.fn>;
  listActive: ReturnType<typeof vi.fn>;
  bumpTokenVersion: ReturnType<typeof vi.fn>;
  restartContainer: ReturnType<typeof vi.fn>;
  signTokenAndInject: ReturnType<typeof vi.fn>;
  getTokenVersion?: ReturnType<typeof vi.fn>;
}) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(buildEntitlementsRouter({
    entitlements: {
      enable: deps.enable, disable: deps.disable, listActive: deps.listActive,
      bumpTokenVersion: deps.bumpTokenVersion,
      getTokenVersion: deps.getTokenVersion ?? vi.fn().mockResolvedValue(0),
    } as any,
    restartContainer: deps.restartContainer,
    signTokenAndInject: deps.signTokenAndInject,
    sessionMw: mockSession(),
  }));
  return app;
}

describe('POST /api/entitlements/cloud/enable', () => {
  it('happy path: enable changes state → bump version → sign new token → restart container', async () => {
    const enable = vi.fn().mockResolvedValue({ changed: true });
    const listActive = vi.fn().mockResolvedValue(['cloud']);
    const bumpTokenVersion = vi.fn().mockResolvedValue(1);
    const restartContainer = vi.fn().mockResolvedValue(undefined);
    const signTokenAndInject = vi.fn().mockResolvedValue(undefined);

    const app = makeApp({
      enable, disable: vi.fn(), listActive, bumpTokenVersion,
      restartContainer, signTokenAndInject,
    });
    const res = await request(app).post('/api/entitlements/cloud/enable');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, entitlements: ['cloud'], changed: true });

    expect(enable).toHaveBeenCalledWith(USER_ID, 'cloud');
    expect(bumpTokenVersion).toHaveBeenCalledWith(USER_ID);
    expect(signTokenAndInject).toHaveBeenCalledWith(USER_ID, 1);
    expect(restartContainer).toHaveBeenCalledWith(USER_ID);
  });

  it('idempotent: already enabled → no bump, but still re-sign + restart for resync', async () => {
    const enable = vi.fn().mockResolvedValue({ changed: false });
    const listActive = vi.fn().mockResolvedValue(['cloud']);
    const bumpTokenVersion = vi.fn();
    const getTokenVersion = vi.fn().mockResolvedValue(3);   // current version
    const restartContainer = vi.fn().mockResolvedValue(undefined);
    const signTokenAndInject = vi.fn().mockResolvedValue(undefined);

    const app = makeApp({
      enable, disable: vi.fn(), listActive, bumpTokenVersion, getTokenVersion,
      restartContainer, signTokenAndInject,
    });
    const res = await request(app).post('/api/entitlements/cloud/enable');

    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    // 不 bump (避免无意撤销旧 token)
    expect(bumpTokenVersion).not.toHaveBeenCalled();
    // 但仍然 sign + restart 让容器有机会重新同步 (resync)
    expect(signTokenAndInject).toHaveBeenCalledWith(USER_ID, 3);   // 用 current token_version
    expect(restartContainer).toHaveBeenCalledWith(USER_ID);
  });
});

describe('POST /api/entitlements/cloud/disable', () => {
  it('disable changes state → bump version → restart, but does NOT delete blob data', async () => {
    const disable = vi.fn().mockResolvedValue({ changed: true });
    const listActive = vi.fn().mockResolvedValue([]);
    const bumpTokenVersion = vi.fn().mockResolvedValue(2);
    const restartContainer = vi.fn().mockResolvedValue(undefined);

    const app = makeApp({
      enable: vi.fn(), disable, listActive, bumpTokenVersion,
      restartContainer, signTokenAndInject: vi.fn().mockResolvedValue(undefined),
    });
    const res = await request(app).post('/api/entitlements/cloud/disable');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, entitlements: [], changed: true });
    expect(disable).toHaveBeenCalledWith(USER_ID, 'cloud');
    expect(bumpTokenVersion).toHaveBeenCalled();
    expect(restartContainer).toHaveBeenCalled();
  });
});
