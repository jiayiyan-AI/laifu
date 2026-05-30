import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { buildStatusRouter } from '../../src/api/status.js';
import { ContainerMappingCache } from '../../src/db/cache.js';
import { signSession } from '../../src/auth/session.js';
import { requireSession } from '../../src/auth/middleware.js';

const SECRET = 'test-secret-do-not-use-in-prod-123456';
const COOKIE_NAME = 'lingxi_sid';

const setupCache = () => {
  const cache = new ContainerMappingCache({} as any);
  cache.set({
    user_id: 'u1',
    container_name: 'hermes-u1abc',
    container_url: null,
    status: 'provisioning',
    provisioning_step: '正在生成数字助理实例',
    progress_pct: 20,
    error_message: null,
    azure_files_share: 'user-u1abc',
    created_at: new Date().toISOString(),
    ready_at: null,
  });
  return cache;
};

const makeApp = (cache: ContainerMappingCache) => {
  const app = express();
  app.use(cookieParser());
  const mw = requireSession({ secret: SECRET, cookieName: COOKIE_NAME });
  app.use(buildStatusRouter(cache, mw));
  return app;
};

const validCookie = (userId: string): string => {
  const token = signSession({ user_id: userId }, SECRET, 24);
  return `${COOKIE_NAME}=${token}`;
};

describe('GET /api/status', () => {
  it('401 when no cookie', async () => {
    const res = await request(makeApp(new ContainerMappingCache({} as any))).get('/api/status');
    expect(res.status).toBe(401);
  });

  it('404 when no row for user', async () => {
    const res = await request(makeApp(new ContainerMappingCache({} as any)))
      .get('/api/status')
      .set('Cookie', validCookie('unknown-user'));
    expect(res.status).toBe(404);
  });

  it('returns status fields when row exists', async () => {
    const res = await request(makeApp(setupCache()))
      .get('/api/status')
      .set('Cookie', validCookie('u1'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'provisioning',
      provisioning_step: '正在生成数字助理实例',
      progress_pct: 20,
      error_message: null,
    });
  });
});
