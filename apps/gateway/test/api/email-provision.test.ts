import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

import { dao } from '../../src/db/index.js';
import { defaultLocalpart, ensureEmailAddress } from '../../src/api/email-provision.js';

const UID = '6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f';

describe('defaultLocalpart', () => {
  it('= u- + 去横线前 8 hex', () => {
    expect(defaultLocalpart(UID)).toBe('u-6e8b21f0');
  });
});

describe('ensureEmailAddress', () => {
  it('已有地址 → 直接返回, 不 insert', async () => {
    vi.mocked(dao.email.getAddress).mockResolvedValue({ localpart: 'sunco', display_name: null });
    const lp = await ensureEmailAddress(UID);
    expect(lp).toBe('sunco');
    expect(dao.email.insertAddress).not.toHaveBeenCalled();
  });

  it('无地址 → 插入默认 localpart 并返回', async () => {
    vi.mocked(dao.email.getAddress).mockResolvedValue(null);
    vi.mocked(dao.email.insertAddress).mockResolvedValue(undefined);
    const lp = await ensureEmailAddress(UID);
    expect(lp).toBe('u-6e8b21f0');
    expect(dao.email.insertAddress).toHaveBeenCalledWith(UID, 'u-6e8b21f0', null);
  });

  it('插入冲突但 re-query 已存在(并发)→ 返回已存在的', async () => {
    vi.mocked(dao.email.getAddress)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ localpart: 'u-6e8b21f0', display_name: null });
    vi.mocked(dao.email.insertAddress).mockRejectedValueOnce(new Error('duplicate key'));
    const lp = await ensureEmailAddress(UID);
    expect(lp).toBe('u-6e8b21f0');
  });

  it('插入冲突且 re-query 仍无(跨用户 8hex 撞了)→ 用全 hex 重试', async () => {
    vi.mocked(dao.email.getAddress)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    vi.mocked(dao.email.insertAddress)
      .mockRejectedValueOnce(new Error('duplicate key'))
      .mockResolvedValueOnce(undefined);
    const lp = await ensureEmailAddress(UID);
    expect(lp).toBe('u-' + UID.replace(/-/g, ''));
    expect(dao.email.insertAddress).toHaveBeenLastCalledWith(UID, 'u-' + UID.replace(/-/g, ''), null);
  });
});
