import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

import { dao } from '../../src/db/index.js';
import { buildPurchaseRouter } from '../../src/api/purchase.js';
import { signSession } from '../../src/auth/session.js';
import { requireSession } from '../../src/auth/middleware.js';

const SECRET = 'test-secret-do-not-use-in-prod-123456';
const COOKIE_NAME = 'lingxi_sid';

describe('POST /api/purchase', () => {
  beforeEach(() => {
    let inserted: any = null;
    vi.mocked(dao.containerMapping.insert).mockImplementation(async (row: any) => { inserted = row; });
    vi.mocked(dao.containerMapping.getByUserId).mockImplementation(async () => inserted ? { ...inserted, container_url: null, provisioning_step: null, error_message: null, created_at: new Date().toISOString(), ready_at: null } : null);
    vi.mocked(dao.cache.get).mockReturnValue(null);
  });

  const makeApp = (provisioner: any) => {
    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    const mw = requireSession({ secret: SECRET, cookieName: COOKIE_NAME });
    app.use(buildPurchaseRouter(provisioner, mw));
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
    expect(dao.containerMapping.insert).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'u1' }));
    expect(provisioner).toHaveBeenCalledOnce();
  });

  it('401 when no session cookie', async () => {
    const provisioner = vi.fn();
    const res = await request(makeApp(provisioner)).post('/api/purchase');
    expect(res.status).toBe(401);
  });
});
