import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/index.js';
import { ContainerMappingCache } from '../../src/db/cache.js';

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

  it('inserts container_mapping row, returns provisioning, kicks off async task', async () => {
    const provisioner = vi.fn(() => Promise.resolve());
    const app = createApp({ cache, sb: mockSb, provisioner });

    const res = await request(app).post('/api/purchase').set('x-user-id', 'u1');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('provisioning');
    expect(res.body.user_id).toBe('u1');

    expect(inserted).toMatchObject({
      user_id: 'u1',
      status: 'provisioning',
      progress_pct: 0,
    });
    expect(inserted.container_name).toMatch(/^hermes-/);
    expect(inserted.azure_files_share).toMatch(/^user-/);

    expect(provisioner).toHaveBeenCalledOnce();
  });

  it('400 when x-user-id missing', async () => {
    const app = createApp({ cache, sb: mockSb, provisioner: vi.fn() });
    const res = await request(app).post('/api/purchase');
    expect(res.status).toBe(400);
  });
});
