import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

import { dao } from '../../src/db/index.js';
import { defaultLocalpart, claimEmailAddress, EmailTakenError } from '../../src/api/email-provision.js';

const UID = '6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f';
// 真实形状: Drizzle(node-postgres) 把 pg 错误包成 DrizzleQueryError, 23505 在 .cause 上,
// 顶层 .code 是 undefined。用这个形状才能真正测到 isUniqueViolation 看 .cause(否则假绿)。
const dup = () => Object.assign(new Error('DrizzleQueryError'), { cause: Object.assign(new Error('dup'), { code: '23505' }) });

beforeEach(() => { vi.clearAllMocks(); });   // 清调用历史，避免 toHaveBeenCalledTimes 跨用例累计

describe('defaultLocalpart', () => {
  it('= u- + 去横线前 8 hex', () => {
    expect(defaultLocalpart(UID)).toBe('u-6e8b21f0');
  });
});

describe('claimEmailAddress', () => {
  it('已有地址 → 直接返回, 不 insert', async () => {
    vi.mocked(dao.email.getAddress).mockResolvedValue({ localpart: 'sunco', display_name: null });
    const lp = await claimEmailAddress(UID, { localpart: 'whatever' });
    expect(lp).toBe('sunco');
    expect(dao.email.insertAddress).not.toHaveBeenCalled();
  });

  it('用户自填 localpart → 小写后原样 insert 并返回（不再拼音派生）', async () => {
    vi.mocked(dao.email.getAddress).mockResolvedValue(null);
    vi.mocked(dao.email.insertAddress).mockResolvedValue(undefined);
    const lp = await claimEmailAddress(UID, { localpart: 'Aria', displayName: '小林' });
    expect(lp).toBe('aria');
    expect(dao.email.insertAddress).toHaveBeenCalledWith(UID, 'aria', '小林');
  });

  it('未传 localpart + 无名字 → u-<hash> 默认', async () => {
    vi.mocked(dao.email.getAddress).mockResolvedValue(null);
    vi.mocked(dao.containerMapping.getByUserId).mockResolvedValue(null);
    vi.mocked(dao.email.insertAddress).mockResolvedValue(undefined);
    const lp = await claimEmailAddress(UID);
    expect(lp).toBe('u-6e8b21f0');
    expect(dao.email.insertAddress).toHaveBeenCalledWith(UID, 'u-6e8b21f0', null);
  });

  it('未传 displayName → 从 containerMapping 读 assistant_name 作 display_name', async () => {
    vi.mocked(dao.email.getAddress).mockResolvedValue(null);
    vi.mocked(dao.containerMapping.getByUserId).mockResolvedValue({
      user_id: UID, container_name: 'c', azure_files_share: 's', status: 'ready',
      container_url: null, provisioning_step: null, progress_pct: 100, error_message: null,
      created_at: new Date().toISOString(), ready_at: null, policy_hash: null,
      assistant_name: '小林',
    } as any);
    vi.mocked(dao.email.insertAddress).mockResolvedValue(undefined);
    await claimEmailAddress(UID, { localpart: 'aria' });
    expect(dao.email.insertAddress).toHaveBeenCalledWith(UID, 'aria', '小林');
  });

  it('localpart 被占用 → 抛 EmailTakenError（不再自动加后缀，只试一次）', async () => {
    vi.mocked(dao.email.getAddress).mockResolvedValue(null);
    vi.mocked(dao.email.insertAddress).mockRejectedValueOnce(dup());
    await expect(claimEmailAddress(UID, { localpart: 'aria' })).rejects.toBeInstanceOf(EmailTakenError);
    expect(dao.email.insertAddress).toHaveBeenCalledTimes(1);
  });

  it('非唯一冲突的 DB 错误 → 冒泡（不当成被占用）', async () => {
    vi.mocked(dao.email.getAddress).mockResolvedValue(null);
    vi.mocked(dao.email.insertAddress).mockRejectedValueOnce(new Error('connection refused'));
    await expect(claimEmailAddress(UID, { localpart: 'aria' })).rejects.toThrow(/connection refused/);
  });
});
