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
  let mockMappingDao: any;
  let mockUsersDao: any;
  let mockCache: any;
  let mockAzure: any;

  beforeEach(() => {
    mockMappingDao = {
      insert: vi.fn(async () => {}),
      getByUserId: vi.fn(async () => finalReadyRow),
      listByStatus: vi.fn(async () => []),
      updateStep: vi.fn(async () => {}),
      markReady: vi.fn(async () => {}),
      markFailed: vi.fn(async () => {}),
    };
    mockUsersDao = {
      getById: vi.fn(async () => null),
      getTokenVersion: vi.fn(async () => 0),
      upsertByProvider: vi.fn(async () => null),
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
      mappingDao: mockMappingDao,
      usersDao: mockUsersDao,
      cache: mockCache,
      azure: mockAzure,
    });

    // updateStep called for intermediate steps
    expect(mockMappingDao.updateStep.mock.calls.length).toBeGreaterThanOrEqual(5);
    // markReady called with URL
    expect(mockMappingDao.markReady).toHaveBeenCalledWith(
      'u1', 'https://hermes-u1abc.example.com', '灵犀助理上岗完成', 100,
    );

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
      mappingDao: mockMappingDao,
      usersDao: mockUsersDao,
      cache: mockCache,
      azure: mockAzure,
    });

    expect(mockMappingDao.markFailed).toHaveBeenCalledWith('u1', 'Azure quota exceeded');
  });
});
