import { describe, it, expect, vi } from 'vitest';
import { defaultLocalpart, ensureEmailAddress } from '../../src/api/email-provision.js';

const UID = '6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f';

describe('defaultLocalpart', () => {
  it('= u- + 去横线前 8 hex', () => {
    expect(defaultLocalpart(UID)).toBe('u-6e8b21f0');
  });
});

describe('ensureEmailAddress', () => {
  it('已有地址 → 直接返回, 不 insert', async () => {
    const dao = {
      getAddress: vi.fn().mockResolvedValue({ localpart: 'sunco', display_name: null }),
      insertAddress: vi.fn(),
    };
    const lp = await ensureEmailAddress(dao as any, UID);
    expect(lp).toBe('sunco');
    expect(dao.insertAddress).not.toHaveBeenCalled();
  });

  it('无地址 → 插入默认 localpart 并返回', async () => {
    const dao = {
      getAddress: vi.fn().mockResolvedValue(null),
      insertAddress: vi.fn().mockResolvedValue(undefined),
    };
    const lp = await ensureEmailAddress(dao as any, UID);
    expect(lp).toBe('u-6e8b21f0');
    expect(dao.insertAddress).toHaveBeenCalledWith(UID, 'u-6e8b21f0', null);
  });

  it('插入冲突但 re-query 已存在(并发)→ 返回已存在的', async () => {
    const dao = {
      getAddress: vi.fn()
        .mockResolvedValueOnce(null)                                  // 首次: 无
        .mockResolvedValueOnce({ localpart: 'u-6e8b21f0', display_name: null }), // 冲突后 re-query: 有
      insertAddress: vi.fn().mockRejectedValueOnce(new Error('insertAddress: duplicate key')),
    };
    const lp = await ensureEmailAddress(dao as any, UID);
    expect(lp).toBe('u-6e8b21f0');
  });

  it('插入冲突且 re-query 仍无(跨用户 8hex 撞了)→ 用全 hex 重试', async () => {
    const dao = {
      getAddress: vi.fn()
        .mockResolvedValueOnce(null)   // 首次
        .mockResolvedValueOnce(null),  // 冲突后 re-query 仍无 → 真撞别的用户
      insertAddress: vi.fn()
        .mockRejectedValueOnce(new Error('insertAddress: duplicate key'))  // 短 localpart 撞
        .mockResolvedValueOnce(undefined),                                  // 全 hex 成功
    };
    const lp = await ensureEmailAddress(dao as any, UID);
    expect(lp).toBe('u-' + UID.replace(/-/g, ''));
    expect(dao.insertAddress).toHaveBeenLastCalledWith(UID, 'u-' + UID.replace(/-/g, ''), null);
  });
});
