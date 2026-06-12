import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

import { dao } from '../../src/db/index.js';
import { recoverProvisioning } from '../../src/provisioning/recovery.js';

describe('recoverProvisioning', () => {
  let mockAzure: any;

  beforeEach(() => {
    mockAzure = { getContainerAppState: vi.fn() };
  });

  it('Succeeded → updates status=ready with fqdn', async () => {
    vi.mocked(dao.containerMapping.listByStatus).mockResolvedValue([{ user_id: 'u1', container_name: 'hermes-u1' }]);
    mockAzure.getContainerAppState.mockResolvedValue({
      state: 'Succeeded',
      fqdn: 'https://hermes-u1.example.com',
    });

    await recoverProvisioning(mockAzure);

    expect(dao.containerMapping.markReady).toHaveBeenCalledWith('u1', 'https://hermes-u1.example.com', '灵犀助理上岗完成', 100);
  });

  it('Failed → updates status=failed', async () => {
    vi.mocked(dao.containerMapping.listByStatus).mockResolvedValue([{ user_id: 'u1', container_name: 'hermes-u1' }]);
    mockAzure.getContainerAppState.mockResolvedValue({ state: 'Failed', fqdn: null });

    await recoverProvisioning(mockAzure);

    expect(dao.containerMapping.markFailed).toHaveBeenCalledWith('u1', 'Azure state: Failed');
  });

  it('not found → updates status=failed with error', async () => {
    vi.mocked(dao.containerMapping.listByStatus).mockResolvedValue([{ user_id: 'u1', container_name: 'hermes-u1' }]);
    mockAzure.getContainerAppState.mockRejectedValue(new Error('ResourceNotFound'));

    await recoverProvisioning(mockAzure);

    expect(dao.containerMapping.markFailed).toHaveBeenCalledWith('u1', 'ResourceNotFound');
  });
});
