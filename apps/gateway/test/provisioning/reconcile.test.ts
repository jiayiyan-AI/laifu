import { describe, it, expect, beforeEach, vi } from 'vitest';

// provisioner 必须是 azure, 否则 checkAndReconcileACA / sweep 直接早退。
vi.mock('../../src/config.js', () => ({
  config: { provisioner: 'azure' },
}));

// 隔离 azure 真实模块 (会 new DefaultAzureCredential + 读 config 算哈希)。
const { reconcileContainerAppAzure } = vi.hoisted(() => ({
  reconcileContainerAppAzure: vi.fn(async () => {}),
}));
vi.mock('../../src/provisioning/azure.js', () => ({
  policyHashFor: (_userId: string) => 'HASH_NEW',
  reconcileContainerAppAzure,
}));

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

import { dao } from '../../src/db/index.js';
import { checkAndReconcileACA, sweepReconcileAll } from '../../src/provisioning/reconcile.js';
import type { ContainerMapping } from '@lingxi/shared';

const row = (userId: string, policy_hash: string | null, status = 'ready'): ContainerMapping => ({
  user_id: userId,
  container_name: `hermes-${userId}`,
  container_url: `https://${userId}.example.com`,
  status: status as ContainerMapping['status'],
  provisioning_step: null,
  progress_pct: 100,
  error_message: null,
  azure_files_share: `user-${userId}`,
  created_at: '2026-01-01',
  ready_at: '2026-01-01',
  policy_hash,
});

/** 让 fire-and-forget 的 reconcileUser 跑完所有微任务 (reconcile → setPolicyHash → getByUserId → cache.set)。 */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('checkAndReconcileACA', () => {
  beforeEach(() => {
    reconcileContainerAppAzure.mockClear();
    vi.mocked(dao.containerMapping.setPolicyHash).mockClear();
    vi.mocked(dao.cache.set).mockClear();
    vi.mocked(dao.containerMapping.getByUserId).mockReset();
    vi.mocked(dao.containerMapping.getByUserId).mockResolvedValue(null as never);
  });

  it('命中 (policy_hash === POLICY_HASH) 不触发 reconcile', () => {
    vi.mocked(dao.cache.get).mockReturnValue(row('hit', 'HASH_NEW'));
    checkAndReconcileACA('hit');
    expect(reconcileContainerAppAzure).not.toHaveBeenCalled();
  });

  it('status 非 ready 直接跳过 (交给创建流程)', () => {
    vi.mocked(dao.cache.get).mockReturnValue(row('prov', 'HASH_OLD', 'provisioning'));
    checkAndReconcileACA('prov');
    expect(reconcileContainerAppAzure).not.toHaveBeenCalled();
  });

  it('无缓存行直接跳过', () => {
    vi.mocked(dao.cache.get).mockReturnValue(null);
    checkAndReconcileACA('missing');
    expect(reconcileContainerAppAzure).not.toHaveBeenCalled();
  });

  it('stale 触发后台 reconcile 并写回哈希 + 刷新缓存', async () => {
    const stale = row('stale', 'HASH_OLD');
    vi.mocked(dao.cache.get).mockReturnValue(stale);
    const fresh = row('stale', 'HASH_NEW');
    vi.mocked(dao.containerMapping.getByUserId).mockResolvedValue(fresh as never);

    checkAndReconcileACA('stale');
    expect(reconcileContainerAppAzure).toHaveBeenCalledWith('stale');   // 同步发起

    await flush();
    expect(dao.containerMapping.setPolicyHash).toHaveBeenCalledWith('stale', 'HASH_NEW');
    expect(dao.cache.set).toHaveBeenCalledWith(fresh);
  });

  it('同一用户并发去重: 多次调用只发起一次 reconcile', async () => {
    vi.mocked(dao.cache.get).mockReturnValue(row('dup', 'HASH_OLD'));
    checkAndReconcileACA('dup');
    checkAndReconcileACA('dup');
    checkAndReconcileACA('dup');
    expect(reconcileContainerAppAzure).toHaveBeenCalledTimes(1);
    await flush();
  });

  it('reconcile 失败不写回哈希 (保证下次重试)', async () => {
    vi.mocked(dao.cache.get).mockReturnValue(row('fail', 'HASH_OLD'));
    reconcileContainerAppAzure.mockRejectedValueOnce(new Error('ARM 限流') as never);
    checkAndReconcileACA('fail');
    await flush();
    expect(dao.containerMapping.setPolicyHash).not.toHaveBeenCalled();
  });
});

describe('sweepReconcileAll', () => {
  beforeEach(() => {
    reconcileContainerAppAzure.mockClear();
    vi.mocked(dao.containerMapping.setPolicyHash).mockClear();
    vi.mocked(dao.containerMapping.getByUserId).mockResolvedValue(null as never);
  });

  it('只 reconcile stale 且 ready 的行, 命中 / 非 ready 跳过', async () => {
    vi.mocked(dao.cache.entries).mockReturnValue([
      row('a', 'HASH_OLD'),                 // stale → reconcile
      row('b', 'HASH_NEW'),                 // 命中 → skip
      row('c', 'HASH_OLD', 'provisioning'), // 非 ready → skip
      row('d', null),                       // 存量 NULL → reconcile
    ]);

    await sweepReconcileAll();

    expect(reconcileContainerAppAzure).toHaveBeenCalledTimes(2);
    const reconciled = reconcileContainerAppAzure.mock.calls.map((c) => c[0]);
    expect(reconciled.sort()).toEqual(['a', 'd']);
  });

  it('全员命中时零 ARM 调用', async () => {
    vi.mocked(dao.cache.entries).mockReturnValue([
      row('a', 'HASH_NEW'),
      row('b', 'HASH_NEW'),
    ]);
    await sweepReconcileAll();
    expect(reconcileContainerAppAzure).not.toHaveBeenCalled();
  });
});
