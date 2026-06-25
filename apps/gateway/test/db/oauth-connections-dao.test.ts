import { describe, it, expect, vi } from 'vitest';
import type { Db } from '@lingxi/db';
import {
  makeOauthConnectionsDao,
  type UpsertOauthConnectionArgs,
} from '../../src/db/oauth-connections-dao.js';

/**
 * upsertByUserAndProvider 的 metadata 保留语义 (docs/todo/github.md 走查 #1):
 * 重连不传 metadata 时, onConflictDoUpdate.set 必须省略 metadata 键 (保留旧值,
 * 不抹 installation_id/team_id 等); 显式传入 (含 null) 才覆盖。
 */

interface OnConflictArgs {
  target: unknown;
  set: Record<string, unknown>;
}

// toConnection 读取的列形状 (Date 字段需真 Date, 它会调 toISOString)。
const fakeRow = {
  id: 'uuid-1',
  user_id: 'user-1',
  provider: 'github',
  external_account_id: '123',
  external_login: 'octocat',
  encrypted_access_token: 'enc-access',
  encrypted_refresh_token: null,
  access_token_expires_at: null,
  token_scopes: ['repo'],
  metadata: null,
  connected_at: new Date('2026-06-01T00:00:00Z'),
  last_used_at: null,
};

function mockDb(): { db: Db; getOnConflict: () => OnConflictArgs | null } {
  let onConflictArgs: OnConflictArgs | null = null;
  const insertChain = {
    values: vi.fn(() => insertChain),
    onConflictDoUpdate: vi.fn((args: OnConflictArgs) => {
      onConflictArgs = args;
      return insertChain;
    }),
    returning: vi.fn(() => Promise.resolve([fakeRow])),
  };
  // 库边界: 只实现 DAO 用到的 insert 链, 故 unknown 转 Db (运行时形状已对齐)。
  const db = { insert: vi.fn(() => insertChain) } as unknown as Db;
  return { db, getOnConflict: () => onConflictArgs };
}

const baseArgs: UpsertOauthConnectionArgs = {
  userId: 'user-1',
  provider: 'github',
  externalAccountId: '123',
  externalLogin: 'octocat',
  encryptedAccessToken: 'enc-access',
  tokenScopes: ['repo'],
};

describe('oauthConnectionsDao.upsertByUserAndProvider — metadata 保留', () => {
  it('不传 metadata → set 省略 metadata 键 (重连保留旧值)', async () => {
    const { db, getOnConflict } = mockDb();
    const dao = makeOauthConnectionsDao(db);
    await dao.upsertByUserAndProvider(baseArgs);
    const set = getOnConflict()?.set;
    expect(set).toBeDefined();
    expect('metadata' in set!).toBe(false);
  });

  it('传入 metadata → set 写入该对象', async () => {
    const { db, getOnConflict } = mockDb();
    const dao = makeOauthConnectionsDao(db);
    await dao.upsertByUserAndProvider({ ...baseArgs, metadata: { installation_id: 42 } });
    expect(getOnConflict()?.set.metadata).toEqual({ installation_id: 42 });
  });

  it('显式传 null → set 清空 metadata', async () => {
    const { db, getOnConflict } = mockDb();
    const dao = makeOauthConnectionsDao(db);
    await dao.upsertByUserAndProvider({ ...baseArgs, metadata: null });
    const set = getOnConflict()?.set;
    expect('metadata' in set!).toBe(true);
    expect(set!.metadata).toBeNull();
  });
});
