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

// mock Drizzle db: db.select().from(table) returns rows
function mockDb(rows: any[] | Error) {
  const fromFn = vi.fn(() => {
    if (rows instanceof Error) return Promise.reject(rows);
    return Promise.resolve(rows);
  });
  const selectFn = vi.fn(() => ({ from: fromFn }));
  return { select: selectFn, from: fromFn, _selectFn: selectFn, _fromFn: fromFn };
}

describe('ContainerMappingCache', () => {
  it('returns null for unknown user', () => {
    const db = mockDb([]);
    const cache = new ContainerMappingCache(db as any);
    expect(cache.get('unknown-id')).toBeNull();
  });

  it('returns the entry after set()', () => {
    const db = mockDb([]);
    const cache = new ContainerMappingCache(db as any);
    const row = rowReady('u1', 'https://hermes-u1.example.com');
    cache.set(row);
    expect(cache.get('u1')).toEqual(row);
  });

  it('loadAll() populates cache from DB', async () => {
    // Drizzle select().from() returns array of rows with Date objects for timestamps
    const dbRows = [
      { user_id: 'u1', container_name: 'hermes-u1', container_url: 'url1', status: 'ready', provisioning_step: null, progress_pct: 100, error_message: null, azure_files_share: 'share1', created_at: new Date('2026-01-01'), ready_at: new Date('2026-01-02') },
      { user_id: 'u2', container_name: 'hermes-u2', container_url: 'url2', status: 'ready', provisioning_step: null, progress_pct: 100, error_message: null, azure_files_share: 'share2', created_at: new Date('2026-01-01'), ready_at: new Date('2026-01-02') },
    ];
    const db = mockDb(dbRows);
    const cache = new ContainerMappingCache(db as any);
    await cache.loadAll();
    expect(cache.get('u1')!.container_url).toBe('url1');
    expect(cache.get('u2')!.container_url).toBe('url2');
    // Timestamps should be converted to ISO strings
    expect(typeof cache.get('u1')!.created_at).toBe('string');
  });

  it('loadAll() throws on DB error', async () => {
    const db = mockDb(new Error('boom'));
    const cache = new ContainerMappingCache(db as any);
    await expect(cache.loadAll()).rejects.toThrow('boom');
  });
});
