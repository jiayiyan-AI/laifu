import { describe, it, expect, vi } from 'vitest';
import { makePasswordResetDao } from '../../src/db/password-reset-dao.js';

const mockDb = (returningRows: any[] = []) => {
  const calls: string[] = [];
  const updateChain: any = {
    set: vi.fn(() => updateChain),
    where: vi.fn(() => updateChain),
    returning: vi.fn(async () => returningRows),
    then: (resolve: any) => resolve(undefined),
  };
  const insertChain: any = {
    values: vi.fn(async () => undefined),
  };
  const tx = {
    update: vi.fn(() => { calls.push('update'); return updateChain; }),
    insert: vi.fn(() => { calls.push('insert'); return insertChain; }),
  };
  const db: any = {
    ...tx,
    transaction: vi.fn(async (fn: any) => fn(tx)),
  };
  return { db, calls, insertChain, updateChain };
};

describe('passwordResetDao', () => {
  it('create: 事务内先作废旧 token 再插入新 token', async () => {
    const { db, calls, insertChain } = mockDb();
    await makePasswordResetDao(db).create({ userId: 'u1', tokenHash: 'h1', ttlMinutes: 30 });
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(calls).toEqual(['update', 'insert']);
    expect(insertChain.values.mock.calls[0][0]).toMatchObject({ token_hash: 'h1', user_id: 'u1' });
  });

  it('consume: 命中返回 user_id', async () => {
    const { db } = mockDb([{ user_id: 'u1' }]);
    expect(await makePasswordResetDao(db).consume('h1')).toBe('u1');
  });

  it('consume: 未命中(过期/已用/不存在)返回 null', async () => {
    const { db } = mockDb([]);
    expect(await makePasswordResetDao(db).consume('h1')).toBeNull();
  });
});
