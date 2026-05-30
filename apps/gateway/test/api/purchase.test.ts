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
  let mockSb: any;
  let cache: ContainerMappingCache;
  let inserted: any;
  let thenResult: any;

  beforeEach(() => {
    inserted = null;
    thenResult = { data: null, error: null };
    mockSb = {
      from: vi.fn(() => mockSb),
      insert: vi.fn((row: any) => { inserted = row; return mockSb; }),
      select: vi.fn(() => mockSb),
      eq: vi.fn(() => mockSb),
      single: vi.fn(() => Promise.resolve({ data: inserted, error: null })),
      then: (resolve: any) => resolve(thenResult),
    };
    cache = new ContainerMappingCache(mockSb);
  });

  const makeApp = (provisioner: any) => {
    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    const mw = requireSession({ secret: SECRET, cookieName: COOKIE_NAME });
    app.use(buildPurchaseRouter(mockSb, cache, provisioner, mw));
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
    expect(inserted.user_id).toBe('u1');
    expect(provisioner).toHaveBeenCalledOnce();
  });

  it('401 when no session cookie', async () => {
    const provisioner = vi.fn();
    const res = await request(makeApp(provisioner)).post('/api/purchase');
    expect(res.status).toBe(401);
  });
});
