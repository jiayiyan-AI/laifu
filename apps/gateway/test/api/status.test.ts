import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/index.js';
import { ContainerMappingCache } from '../../src/db/cache.js';

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

describe('GET /api/status', () => {
  it('returns 404 when user has no container_mapping row', async () => {
    const app = createApp({ cache: new ContainerMappingCache({} as any) });
    const res = await request(app).get('/api/status').set('x-user-id', 'unknown');
    expect(res.status).toBe(404);
  });

  it('returns status fields when row exists', async () => {
    const app = createApp({ cache: setupCache() });
    const res = await request(app).get('/api/status').set('x-user-id', 'u1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'provisioning',
      provisioning_step: '正在生成数字助理实例',
      progress_pct: 20,
      error_message: null,
    });
  });
});
