import { describe, it, expect, vi } from 'vitest';
import { makeFeishuBindingDao } from '../../src/db/feishu-binding-dao.js';

/**
 * 轻量 mock Drizzle db 对象。
 * 对齐 email-dao.test.ts 的写法。
 */
function mockDrizzleDb(opts: { selectRows?: any[]; returningRows?: any[]; insertError?: Error } = {}) {
  const captured: any = { insertedValues: null, updatedSet: null, updatedWhere: null };

  // select chain
  const selectChain: any = {
    from: vi.fn(() => selectChain),
    where: vi.fn(() => selectChain),
    orderBy: vi.fn(() => selectChain),
    limit: vi.fn(() => selectChain),
    then: (resolve: any) => resolve(opts.selectRows ?? []),
  };

  // update chain (reuse selectChain shape for set/where)
  const updateChain: any = {
    set: vi.fn((v: any) => {
      captured.updatedSet = v;
      return updateChain;
    }),
    where: vi.fn((v: any) => {
      captured.updatedWhere = v;
      return Promise.resolve();
    }),
  };

  // insert chain
  const insertChain: any = {
    values: vi.fn((v: any) => {
      captured.insertedValues = v;
      if (opts.insertError) return Promise.reject(opts.insertError);
      return insertChain;
    }),
    onConflictDoUpdate: vi.fn((args: any) => {
      captured.onConflictArgs = args;
      return insertChain;
    }),
    returning: vi.fn(() => Promise.resolve(opts.returningRows ?? [])),
  };

  const db = {
    select: vi.fn(() => selectChain),
    insert: vi.fn(() => insertChain),
    update: vi.fn(() => updateChain),
  };

  return { db, captured, selectChain, insertChain, updateChain };
}

// ── 共用假数据 ────────────────────────────────────────────────────────────
const fakeRow = {
  id: 'uuid-1',
  user_id: 'user-1',
  app_id: 'cli_xxx',
  app_secret: 'sec_xxx',
  domain: 'feishu',
  owner_open_id: 'ou_abc',
  thread_id: null,
  status: 'pending_approval',
  is_active: true,
  bound_at: new Date('2026-06-01T00:00:00Z'),
};

describe('feishuBindingDao.listActive', () => {
  it('返回 is_active=true 的行', async () => {
    const { db } = mockDrizzleDb({ selectRows: [fakeRow] });
    const dao = makeFeishuBindingDao(db as any);
    const result = await dao.listActive();
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('uuid-1');
    expect(result[0]!.is_active).toBe(true);
  });

  it('无行时返回空数组', async () => {
    const { db } = mockDrizzleDb({ selectRows: [] });
    const dao = makeFeishuBindingDao(db as any);
    expect(await dao.listActive()).toEqual([]);
  });

  it('where 条件同时包含 is_active 和 status (and 两个条件)', async () => {
    const { db, selectChain } = mockDrizzleDb({ selectRows: [] });
    const dao = makeFeishuBindingDao(db as any);
    await dao.listActive();
    // where 应被调用一次
    expect(selectChain.where).toHaveBeenCalledTimes(1);
    const whereArg = selectChain.where.mock.calls[0]![0];
    expect(whereArg).toBeDefined();
    // Drizzle and(a, b) 在最外层产生一个有 queryChunks 长度=3 的节点
    // (两个子条件 + 中间分隔符), 而单个 eq() 的 queryChunks 长度=5。
    // 借此区分「传了 and() 含两个子条件」与「只传了单个 eq()」。
    const outerChunks: any[] = whereArg?.queryChunks ?? [];
    expect(outerChunks).toHaveLength(3);
    // 中间节点是「( ... and ... )」结构, 其 queryChunks[1].value 含 ' and '
    const innerChunks: any[] = outerChunks[1]?.queryChunks ?? [];
    expect(innerChunks.length).toBeGreaterThanOrEqual(3);
    // 提取 value 类节点中的字符串, 确认含 ' and '
    const andChunk = innerChunks.find((c: any) => Array.isArray(c.value) && c.value.some((s: any) => typeof s === 'string' && s.includes('and')));
    expect(andChunk).toBeDefined();
  });
});

describe('feishuBindingDao.getByUserId', () => {
  it('找到 → 返回绑定', async () => {
    const { db } = mockDrizzleDb({ selectRows: [fakeRow] });
    const dao = makeFeishuBindingDao(db as any);
    const binding = await dao.getByUserId('user-1');
    expect(binding).not.toBeNull();
    expect(binding!.user_id).toBe('user-1');
    expect(binding!.bound_at).toBe('2026-06-01T00:00:00.000Z');
  });

  it('找不到 → null', async () => {
    const { db } = mockDrizzleDb({ selectRows: [] });
    const dao = makeFeishuBindingDao(db as any);
    expect(await dao.getByUserId('no-user')).toBeNull();
  });
});

describe('feishuBindingDao.upsertByUserId', () => {
  it('走 onConflictDoUpdate，返回 FeishuBinding', async () => {
    const { db, captured } = mockDrizzleDb({ returningRows: [fakeRow] });
    const dao = makeFeishuBindingDao(db as any);
    const result = await dao.upsertByUserId({
      userId: 'user-1',
      appId: 'cli_xxx',
      appSecret: 'sec_xxx',
      domain: 'feishu',
      ownerOpenId: 'ou_abc',
    });
    expect(result.id).toBe('uuid-1');
    expect(result.status).toBe('pending_approval');
    // onConflictDoUpdate 应当被调用
    expect(captured.onConflictArgs).toBeDefined();
    expect(captured.onConflictArgs.set).toBeDefined();
  });

  it('returning() 为空时抛出错误', async () => {
    const { db } = mockDrizzleDb({ returningRows: [] });
    const dao = makeFeishuBindingDao(db as any);
    await expect(dao.upsertByUserId({
      userId: 'user-1',
      appId: 'cli_xxx',
      appSecret: 'sec_xxx',
      domain: 'feishu',
      ownerOpenId: 'ou_abc',
    })).rejects.toThrow(/upsertByUserId/);
  });
});

describe('feishuBindingDao.setActive', () => {
  it('设置 is_active=true 和 status', async () => {
    const { db, captured } = mockDrizzleDb();
    const dao = makeFeishuBindingDao(db as any);
    await dao.setActive('uuid-1', 'active');
    expect(captured.updatedSet).toMatchObject({ is_active: true, status: 'active' });
  });
});

describe('feishuBindingDao.bindThread', () => {
  it('写回 thread_id', async () => {
    const { db, captured } = mockDrizzleDb();
    const dao = makeFeishuBindingDao(db as any);
    await dao.bindThread('uuid-1', 'thread-42');
    expect(captured.updatedSet).toMatchObject({ thread_id: 'thread-42' });
  });
});

describe('feishuBindingDao.deactivate', () => {
  it('set is_active=false', async () => {
    const { db, captured } = mockDrizzleDb();
    const dao = makeFeishuBindingDao(db as any);
    await dao.deactivate('uuid-1');
    expect(captured.updatedSet).toMatchObject({ is_active: false });
  });
});
