import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recoverProvisioning } from '../../src/provisioning/recovery.js';

describe('recoverProvisioning', () => {
  let mockMappingDao: any;
  let mockAzure: any;

  beforeEach(() => {
    mockMappingDao = {
      insert: vi.fn(async () => {}),
      getByUserId: vi.fn(async () => null),
      listByStatus: vi.fn(async () => []),
      updateStep: vi.fn(async () => {}),
      markReady: vi.fn(async () => {}),
      markFailed: vi.fn(async () => {}),
    };
    mockAzure = { getContainerAppState: vi.fn() };
  });

  it('Succeeded → updates status=ready with fqdn', async () => {
    mockMappingDao.listByStatus.mockResolvedValue([{ user_id: 'u1', container_name: 'hermes-u1' }]);
    mockAzure.getContainerAppState.mockResolvedValue({
      state: 'Succeeded',
      fqdn: 'https://hermes-u1.example.com',
    });

    await recoverProvisioning(mockMappingDao, mockAzure);

    expect(mockMappingDao.markReady).toHaveBeenCalledWith('u1', 'https://hermes-u1.example.com', '灵犀助理上岗完成', 100);
  });

  it('Failed → updates status=failed', async () => {
    mockMappingDao.listByStatus.mockResolvedValue([{ user_id: 'u1', container_name: 'hermes-u1' }]);
    mockAzure.getContainerAppState.mockResolvedValue({ state: 'Failed', fqdn: null });

    await recoverProvisioning(mockMappingDao, mockAzure);

    expect(mockMappingDao.markFailed).toHaveBeenCalledWith('u1', 'Azure state: Failed');
  });

  it('not found → updates status=failed with error', async () => {
    mockMappingDao.listByStatus.mockResolvedValue([{ user_id: 'u1', container_name: 'hermes-u1' }]);
    mockAzure.getContainerAppState.mockRejectedValue(new Error('ResourceNotFound'));

    await recoverProvisioning(mockMappingDao, mockAzure);

    expect(mockMappingDao.markFailed).toHaveBeenCalledWith('u1', 'ResourceNotFound');
  });
});
