import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recoverProvisioning } from '../../src/provisioning/recovery.js';

describe('recoverProvisioning', () => {
  let mockSb: any;
  let updates: any[];
  let mockAzure: any;
  let selectResult: any;

  beforeEach(() => {
    updates = [];
    selectResult = { data: [], error: null };
    mockSb = {
      from: vi.fn(() => mockSb),
      select: vi.fn(() => mockSb),
      eq: vi.fn(() => mockSb),
      update: vi.fn((u: any) => { updates.push(u); return mockSb; }),
      then: (resolve: any) => resolve(selectResult),
    };
    mockAzure = { getContainerAppState: vi.fn() };
  });

  it('Succeeded → updates status=ready with fqdn', async () => {
    selectResult = {
      data: [{ user_id: 'u1', container_name: 'hermes-u1' }],
      error: null,
    };
    mockAzure.getContainerAppState.mockResolvedValue({
      state: 'Succeeded',
      fqdn: 'https://hermes-u1.example.com',
    });

    await recoverProvisioning(mockSb, mockAzure);

    expect(updates.some((u) => u.status === 'ready' && u.container_url === 'https://hermes-u1.example.com')).toBe(true);
  });

  it('Failed → updates status=failed', async () => {
    selectResult = {
      data: [{ user_id: 'u1', container_name: 'hermes-u1' }],
      error: null,
    };
    mockAzure.getContainerAppState.mockResolvedValue({ state: 'Failed', fqdn: null });

    await recoverProvisioning(mockSb, mockAzure);

    expect(updates.some((u) => u.status === 'failed')).toBe(true);
  });

  it('not found → updates status=failed with error', async () => {
    selectResult = {
      data: [{ user_id: 'u1', container_name: 'hermes-u1' }],
      error: null,
    };
    mockAzure.getContainerAppState.mockRejectedValue(new Error('ResourceNotFound'));

    await recoverProvisioning(mockSb, mockAzure);

    const failed = updates.find((u) => u.status === 'failed');
    expect(failed).toBeDefined();
    expect(failed.error_message).toContain('ResourceNotFound');
  });
});
