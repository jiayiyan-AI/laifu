import { describe, it, expect, beforeEach, vi } from 'vitest';
import { provisionContainer } from '../../src/provisioning/manager.js';

const finalReadyRow = {
  user_id: 'u1',
  container_name: 'hermes-u1abc',
  azure_files_share: 'user-u1abc',
  status: 'ready' as const,
  container_url: 'https://hermes-u1abc.example.com',
  provisioning_step: '灵犀助理上岗完成',
  progress_pct: 100,
  error_message: null,
  created_at: new Date().toISOString(),
  ready_at: new Date().toISOString(),
};

describe('provisionContainer', () => {
  let mockSb: any;
  let mockCache: any;
  let mockAzure: any;
  const updates: any[] = [];
  let thenResult: any;

  beforeEach(() => {
    updates.length = 0;
    thenResult = { data: null, error: null };
    // 关键模式：mockSb 自身是 thenable（让 update().eq() 可 await），
    // 同时所有链式方法返回 mockSb，single() 返回 Promise（带最终数据）。
    mockSb = {
      from: vi.fn(() => mockSb),
      update: vi.fn((u: any) => { updates.push(u); return mockSb; }),
      insert: vi.fn(() => mockSb),
      select: vi.fn(() => mockSb),
      eq: vi.fn(() => mockSb),
      single: vi.fn(() => Promise.resolve({ data: finalReadyRow, error: null })),
      then: (resolve: any) => resolve(thenResult),  // await mockSb 时触发
    };
    mockCache = { set: vi.fn(), delete: vi.fn() };
    mockAzure = {
      createFileShare: vi.fn(() => Promise.resolve()),
      createContainerApp: vi.fn(() => Promise.resolve('https://hermes-u1abc.example.com')),
    };
  });

  it('updates provisioning_step through all phases and marks ready on success', async () => {
    await provisionContainer({
      userId: 'u1',
      containerName: 'hermes-u1abc',
      shareName: 'user-u1abc',
      sb: mockSb,
      cache: mockCache,
      azure: mockAzure,
    });

    const stepUpdates = updates.filter((u) => 'provisioning_step' in u);
    expect(stepUpdates.length).toBeGreaterThanOrEqual(5);

    const readyUpdate = updates.find((u) => u.status === 'ready');
    expect(readyUpdate).toBeDefined();
    expect(readyUpdate.container_url).toBe('https://hermes-u1abc.example.com');
    expect(readyUpdate.progress_pct).toBe(100);

    expect(mockAzure.createFileShare).toHaveBeenCalledWith('user-u1abc');
    expect(mockAzure.createContainerApp).toHaveBeenCalledWith({
      containerName: 'hermes-u1abc',
      shareName: 'user-u1abc',
    });

    expect(mockCache.set).toHaveBeenCalled();
  });

  it('marks failed if Azure throws', async () => {
    mockAzure.createContainerApp = vi.fn(() => Promise.reject(new Error('Azure quota exceeded')));

    await provisionContainer({
      userId: 'u1',
      containerName: 'hermes-u1abc',
      shareName: 'user-u1abc',
      sb: mockSb,
      cache: mockCache,
      azure: mockAzure,
    });

    const failedUpdate = updates.find((u) => u.status === 'failed');
    expect(failedUpdate).toBeDefined();
    expect(failedUpdate.error_message).toContain('Azure quota exceeded');
  });
});
