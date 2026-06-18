/**
 * 测试用 DAO mock 工厂。
 *
 * 用法:
 *   vi.mock('../../src/db/index.js', () => mockDaoModule());
 *   // 然后在测试里 import { dao } from '../../src/db/index.js' 拿到 mock 对象
 */
import { vi } from 'vitest';

export const createMockDao = () => ({
  users: {
    getById: vi.fn(async () => null),
    getTokenVersion: vi.fn(async () => 0),
    upsertByProvider: vi.fn(async () => null),
    createPasswordUser: vi.fn(async () => ({ id: 'u_new' })),
    getPasswordUserByEmail: vi.fn(async () => null),
  },
  containerMapping: {
    insert: vi.fn(async () => {}),
    getByUserId: vi.fn(async () => null),
    listByStatus: vi.fn(async () => []),
    updateStep: vi.fn(async () => {}),
    markReady: vi.fn(async () => {}),
    markFailed: vi.fn(async () => {}),
    setPolicyHash: vi.fn(async () => {}),
  },
  messages: {
    insert: vi.fn(async () => {}),
    listByThread: vi.fn(async () => []),
  },
  threads: {
    create: vi.fn(async (row: any) => ({ ...row, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), archived: false })),
    listByUser: vi.fn(async () => []),
    getByIdAndUser: vi.fn(async () => null),
    deleteById: vi.fn(async () => true),
  },
  agentLoops: {
    create: vi.fn(async () => {}),
    complete: vi.fn(async () => true),
    recordResult: vi.fn(async () => true),
    getById: vi.fn(async () => null),
    getActive: vi.fn(async () => null),
    failOrphans: vi.fn(async () => 0),
  },
  wechatBindings: {
    listActive: vi.fn(async () => []),
    getByUserId: vi.fn(async () => null),
    upsertByUserId: vi.fn(async () => ({})),
    updateCursor: vi.fn(async () => {}),
    bindThread: vi.fn(async () => {}),
    deactivate: vi.fn(async () => {}),
  },
  email: {
    findUserByLocalpart: vi.fn(async () => null),
    getAddress: vi.fn(async () => null),
    insertAddress: vi.fn(async () => {}),
    insertInbound: vi.fn(async () => 'eml_test'),
    insertOutbound: vi.fn(async () => 'eml_test'),
    list: vi.fn(async () => []),
    get: vi.fn(async () => null),
  },
  entitlements: {
    listActive: vi.fn(async () => []),
    enable: vi.fn(async () => ({ changed: true })),
    disable: vi.fn(async () => ({ changed: true })),
    getTokenVersion: vi.fn(async () => 0),
    bumpTokenVersion: vi.fn(async () => 1),
  },
  usage: {
    recordUsage: vi.fn(async () => ({ cost_cny: 0 })),
    getBalance: vi.fn(async () => ({ balance_cny: 10, free_quota_cny_month: 5, used_cny_month: 0, period_start: '2026-01-01' })),
  },
  observedState: {
    upsert: vi.fn(async () => {}),
    get: vi.fn(async () => null),
  },
  cache: {
    get: vi.fn(() => null),
    set: vi.fn(),
    delete: vi.fn(),
    loadAll: vi.fn(async () => {}),
    entries: vi.fn(() => []),
  },
});

/** 返回一个可直接作为 vi.mock 工厂的对象 */
export const mockDaoModule = () => {
  const mockDao = createMockDao();
  return {
    dao: mockDao,
    getDb: vi.fn(() => ({})),
    closeDb: vi.fn(async () => {}),
    resetDao: vi.fn(),
  };
};
