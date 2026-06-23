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

  it('无地址 + 有名字 → 插入名字派生的 localpart 并返回', async () => {
    vi.mocked(dao.email.getAddress).mockResolvedValue(null);
    vi.mocked(dao.email.insertAddress).mockResolvedValue(undefined);
    const lp = await ensureEmailAddress(UID, '小林');
    // assistantLocalpartBase('小林') = 'xiaolin'
    expect(lp).toBe('xiaolin');
    expect(dao.email.insertAddress).toHaveBeenCalledWith(UID, 'xiaolin', '小林');
  });

  it('无地址 + 无名字 → 退回 u-<hash> 默认 localpart', async () => {
    vi.mocked(dao.email.getAddress).mockResolvedValue(null);
    vi.mocked(dao.containerMapping.getByUserId).mockResolvedValue(null);
    vi.mocked(dao.email.insertAddress).mockResolvedValue(undefined);
    const lp = await ensureEmailAddress(UID);
    expect(lp).toBe('u-6e8b21f0');
    expect(dao.email.insertAddress).toHaveBeenCalledWith(UID, 'u-6e8b21f0', null);
  });

  it('无名字 → 从 containerMapping 读 assistant_name 后派生', async () => {
    vi.mocked(dao.email.getAddress).mockResolvedValue(null);
    vi.mocked(dao.containerMapping.getByUserId).mockResolvedValue({
      user_id: UID, container_name: 'c', azure_files_share: 's', status: 'ready',
      container_url: null, provisioning_step: null, progress_pct: 100, error_message: null,
      created_at: new Date().toISOString(), ready_at: null, policy_hash: null,
      assistant_name: '小林',
    } as any);
    vi.mocked(dao.email.insertAddress).mockResolvedValue(undefined);
    const lp = await ensureEmailAddress(UID);
    expect(lp).toBe('xiaolin');
  });

  it('base localpart 被占 → 试 -2 后缀', async () => {
    vi.mocked(dao.email.getAddress).mockResolvedValue(null);
    vi.mocked(dao.email.insertAddress)
      .mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }))  // base 撞了
      .mockResolvedValueOnce(undefined);                   // base-2 成功
    const lp = await ensureEmailAddress(UID, '小林');
    expect(lp).toBe('xiaolin-2');
  });

  it('前 5 候选都撞 → 用 base-<short6hex> 兜底', async () => {
    vi.mocked(dao.email.getAddress).mockResolvedValue(null);
    vi.mocked(dao.email.insertAddress)
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }))  // base
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }))  // base-2
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }))  // base-3
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }))  // base-4
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }))  // base-5
      .mockResolvedValueOnce(undefined);         // base-<short6> 成功
    const short6 = UID.replace(/-/g, '').slice(0, 6);
    const lp = await ensureEmailAddress(UID, '小林');
    expect(lp).toBe(`xiaolin-${short6}`);
  });

  it('全部 6 候选都被占 → 终极兜底带完整 userId hex', async () => {
    vi.mocked(dao.email.getAddress).mockResolvedValue(null);
    vi.mocked(dao.email.insertAddress)
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }))  // base
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }))  // base-2
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }))  // base-3
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }))  // base-4
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }))  // base-5
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }))  // base-<short6>
      .mockResolvedValueOnce(undefined);                                           // base-<fullhex> 成功
    const fullHex = UID.replace(/-/g, '');
    const lp = await ensureEmailAddress(UID, '小林');
    expect(lp).toBe(`xiaolin-${fullHex}`);
  });
});
