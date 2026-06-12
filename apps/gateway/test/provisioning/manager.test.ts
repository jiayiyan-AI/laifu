import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

import { dao } from '../../src/db/index.js';
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
  let mockAzure: any;

  beforeEach(() => {
    vi.mocked(dao.containerMapping.getByUserId).mockResolvedValue(finalReadyRow as any);
    vi.mocked(dao.users.getTokenVersion).mockResolvedValue(0);
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
      azure: mockAzure,
    });

    expect(vi.mocked(dao.containerMapping.updateStep).mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(dao.containerMapping.markReady).toHaveBeenCalledWith(
      'u1', 'https://hermes-u1abc.example.com', '灵犀助理上岗完成', 100,
    );

    expect(mockAzure.createFileShare).toHaveBeenCalledWith('user-u1abc');
    expect(mockAzure.createContainerApp).toHaveBeenCalledWith({
      containerName: 'hermes-u1abc',
      shareName: 'user-u1abc',
    });

    expect(dao.cache.set).toHaveBeenCalled();
  });

  it('marks failed if Azure throws', async () => {
    mockAzure.createContainerApp = vi.fn(() => Promise.reject(new Error('Azure quota exceeded')));

    await provisionContainer({
      userId: 'u1',
      containerName: 'hermes-u1abc',
      shareName: 'user-u1abc',
      azure: mockAzure,
    });

    expect(dao.containerMapping.markFailed).toHaveBeenCalledWith('u1', 'Azure quota exceeded');
  });
});
