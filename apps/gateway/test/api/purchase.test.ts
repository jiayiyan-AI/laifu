import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { buildPurchaseRouter } from '../../src/api/purchase.js';
import { ContainerMappingCache } from '../../src/db/cache.js';
import { signSession } from '../../src/auth/session.js';
import { requireSession } from '../../src/auth/middleware.js';

const SECRET = 'test-secret-do-not-use-in-prod-123456';
const COOKIE_NAME = 'lingxi_sid';

describe('POST /api/purchase', () => {
  let mockMappingDao: any;
  let mockDb: any;
  let cache: ContainerMappingCache;

  beforeEach(() => {
    let inserted: any = null;
    mockMappingDao = {
      insert: vi.fn(async (row: any) => { inserted = row; }),
      getByUserId: vi.fn(async () => inserted ? { ...inserted, container_url: null, provisioning_step: null, error_message: null, created_at: new Date().toISOString(), ready_at: null } : null),
      listByStatus: vi.fn(async () => []),
      updateStep: vi.fn(async () => {}),
      markReady: vi.fn(async () => {}),
      markFailed: vi.fn(async () => {}),
    };
    // mock db for ContainerMappingCache
    mockDb = { select: vi.fn(() => ({ from: vi.fn(() => Promise.resolve([])) })) };
    cache = new ContainerMappingCache(mockDb as any);
  });

  const makeApp = (provisioner: any) => {
    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    const mw = requireSession({ secret: SECRET, cookieName: COOKIE_NAME });
    app.use(buildPurchaseRouter(mockMappingDao, cache, provisioner, mw));
    return app;
  };

  const validCookie = (userId: string): string => {
    const token = signSession({ user_id: userId }, SECRET, 24);
    return `${COOKIE_NAME}=${token}`;
  };

  it('inserts container_mapping row, returns provisioning, kicks off async task', async () => {
    const provisioner = vi.fn(() => Promise.resolve());
    const res = await request(makeApp(provisioner))
      .post('/api/purchase')
      .set('Cookie', validCookie('u1'));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('provisioning');
    expect(res.body.user_id).toBe('u1');
    expect(mockMappingDao.insert).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'u1' }));
    expect(provisioner).toHaveBeenCalledOnce();
  });

  it('401 when no session cookie', async () => {
    const provisioner = vi.fn();
    const res = await request(makeApp(provisioner)).post('/api/purchase');
    expect(res.status).toBe(401);
  });
});
