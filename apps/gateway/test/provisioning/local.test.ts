import { describe, it, expect, vi, beforeEach } from 'vitest';
import { provisionContainerLocal } from '../../src/provisioning/local.js';

const finalReadyRow = {
  user_id: 'u1',
  container_name: 'hermes-u1',
  azure_files_share: 'user-u1',
  status: 'ready' as const,
  container_url: 'http://localhost:8080',
  provisioning_step: '灵犀助理上岗完成',
  progress_pct: 100,
  error_message: null,
  created_at: new Date().toISOString(),
  ready_at: new Date().toISOString(),
};

describe('provisionContainerLocal', () => {
  let mockSb: any;
  let mockCache: any;
  const updates: any[] = [];
  let thenResult: any;

  beforeEach(() => {
    updates.length = 0;
    thenResult = { data: null, error: null };
    mockSb = {
      from: vi.fn(() => mockSb),
      update: vi.fn((u: any) => { updates.push(u); return mockSb; }),
      select: vi.fn(() => mockSb),
      eq: vi.fn(() => mockSb),
      single: vi.fn(() => Promise.resolve({ data: finalReadyRow, error: null })),
      then: (resolve: any) => resolve(thenResult),
    };
    mockCache = { set: vi.fn(), delete: vi.fn() };
  });

  it('walks 6 steps and marks ready with localhost URL', async () => {
    await provisionContainerLocal({
      userId: 'u1',
      sb: mockSb,
      cache: mockCache,
      localContainerUrl: 'http://localhost:8080',
      stepDelayMs: 0,
    });

    const stepUpdates = updates.filter((u) => 'provisioning_step' in u);
    expect(stepUpdates.length).toBeGreaterThanOrEqual(5);

    const readyUpdate = updates.find((u) => u.status === 'ready');
    expect(readyUpdate).toBeDefined();
    expect(readyUpdate.container_url).toBe('http://localhost:8080');
    expect(readyUpdate.progress_pct).toBe(100);

    expect(mockCache.set).toHaveBeenCalled();
  });
});
