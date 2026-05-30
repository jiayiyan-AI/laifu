import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ContainerMapping } from '@lingxi/shared';
import { ContainerMappingCache } from '../../src/db/cache.js';

const rowReady = (userId: string, url: string): ContainerMapping => ({
  user_id: userId,
  container_name: `hermes-${userId.slice(0, 8)}`,
  container_url: url,
  status: 'ready',
  provisioning_step: null,
  progress_pct: 100,
  error_message: null,
  azure_files_share: `user-${userId.slice(0, 8)}`,
  created_at: new Date().toISOString(),
  ready_at: new Date().toISOString(),
});

describe('ContainerMappingCache', () => {
  let cache: ContainerMappingCache;
  let mockSb: any;

  beforeEach(() => {
    mockSb = {
      from: vi.fn(() => mockSb),
      select: vi.fn(() => mockSb),
      eq: vi.fn(() => mockSb),
      then: undefined,
    };
    cache = new ContainerMappingCache(mockSb);
  });

  it('returns null for unknown user', () => {
    expect(cache.get('unknown-id')).toBeNull();
  });

  it('returns the entry after set()', () => {
    const row = rowReady('u1', 'https://hermes-u1.example.com');
    cache.set(row);
    expect(cache.get('u1')).toEqual(row);
  });

  it('loadAll() populates cache from DB', async () => {
    const rows = [rowReady('u1', 'url1'), rowReady('u2', 'url2')];
    mockSb.select = vi.fn(() => Promise.resolve({ data: rows, error: null }));
    await cache.loadAll();
    expect(cache.get('u1')).toEqual(rows[0]);
    expect(cache.get('u2')).toEqual(rows[1]);
  });

  it('loadAll() throws on DB error', async () => {
    mockSb.select = vi.fn(() => Promise.resolve({ data: null, error: { message: 'boom' } }));
    await expect(cache.loadAll()).rejects.toThrow('boom');
  });
});
