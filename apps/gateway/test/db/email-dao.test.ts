import { describe, it, expect, vi } from 'vitest';
import { makeEmailDao } from '../../src/db/email-dao.js';

/**
 * 轻量 mock Drizzle db 对象。
 * Drizzle 链式: db.select({...}).from(t).where(...).limit(...) → Promise<rows>
 *              db.insert(t).values({...}) → Promise<void>
 */
function mockDrizzleDb(opts: { selectRows?: any[]; insertError?: Error } = {}) {
  const captured: any = { insertedValues: null };

  // select chain
  const selectChain: any = {
    from: vi.fn(() => selectChain),
    where: vi.fn(() => selectChain),
    orderBy: vi.fn(() => selectChain),
    limit: vi.fn(() => selectChain),
    then: (resolve: any) => resolve(opts.selectRows ?? []),
  };
  // insert chain
  const insertChain: any = {
    values: vi.fn((v: any) => {
      captured.insertedValues = v;
      if (opts.insertError) return Promise.reject(opts.insertError);
      return insertChain;
    }),
    onConflictDoUpdate: vi.fn(() => insertChain),
    returning: vi.fn(() => Promise.resolve([])),
    then: (resolve: any) => resolve(undefined),
  };

  const db = {
    select: vi.fn(() => selectChain),
    insert: vi.fn(() => insertChain),
    update: vi.fn(() => selectChain),
  };

  return { db, captured, selectChain, insertChain };
}

describe('emailDao.findUserByLocalpart', () => {
  it('查到 → 返回 user_id', async () => {
    const { db } = mockDrizzleDb({ selectRows: [{ user_id: 'u1' }] });
    const dao = makeEmailDao(db as any);
    const uid = await dao.findUserByLocalpart('sunco');
    expect(uid).toBe('u1');
  });
  it('查不到 → null', async () => {
    const { db } = mockDrizzleDb({ selectRows: [] });
    const dao = makeEmailDao(db as any);
    expect(await dao.findUserByLocalpart('nope')).toBeNull();
  });
});

describe('emailDao.insertInbound', () => {
  it('落 inbound 行, 生成 eml_ id', async () => {
    const { db, captured } = mockDrizzleDb();
    const dao = makeEmailDao(db as any);
    const id = await dao.insertInbound({
      to_localpart: 'sunco', from_addr: 'bob@x.com', to_addrs: ['sunco@m'], cc_addrs: [],
      subject: '报价', message_id: '<m1>', in_reply_to: null, reference_ids: [],
      body_text: '请确认', has_attachments: false, attachment_keys: [],
    }, 'u1');
    expect(id).toMatch(/^eml_/);
    expect(captured.insertedValues.direction).toBe('inbound');
    expect(captured.insertedValues.user_id).toBe('u1');
    expect(captured.insertedValues.from_addr).toBe('bob@x.com');
  });
});

describe('emailDao.insertInbound + get attachment_keys', () => {
  it('写入 attachment_keys, get 返回相同内容', async () => {
    const attachments = [
      { key: 'k0-a.pdf', filename: 'a.pdf', content_type: 'application/pdf', size: 10 },
    ];
    const fakeRow = {
      id: 'eml_x', direction: 'inbound' as const,
      from_addr: 'bob@x.com', to_addrs: ['sunco@m'], cc_addrs: [],
      subject: '报价带附件', message_id: '<m2>', in_reply_to: null, reference_ids: [],
      body_text: '请查收', has_attachments: true,
      attachment_keys: attachments,
      received_at: new Date('2026-06-10T00:00:00Z'),
    };
    const { db, captured } = mockDrizzleDb({ selectRows: [fakeRow] });
    const dao = makeEmailDao(db as any);

    // 写入
    await dao.insertInbound({
      to_localpart: 'sunco', from_addr: 'bob@x.com', to_addrs: ['sunco@m'], cc_addrs: [],
      subject: '报价带附件', message_id: '<m2>', in_reply_to: null, reference_ids: [],
      body_text: '请查收', has_attachments: true, attachment_keys: attachments,
    }, 'u1');
    expect(captured.insertedValues.attachment_keys).toEqual(attachments);

    // 读取
    const detail = await dao.get('u1', 'eml_x');
    expect(detail!.attachment_keys).toEqual([
      { key: 'k0-a.pdf', filename: 'a.pdf', content_type: 'application/pdf', size: 10 },
    ]);
  });
});

describe('emailDao.list', () => {
  it('映射成 EmailListItem (不含正文)', async () => {
    const rows = [{
      id: 'eml_1', direction: 'inbound', from_addr: 'b@x', to_addrs: ['s@m'],
      subject: '报价', has_attachments: false, received_at: new Date('2026-06-07T00:00:00Z'),
    }];
    const { db } = mockDrizzleDb({ selectRows: rows });
    const dao = makeEmailDao(db as any);
    const out = await dao.list('u1', { limit: 10 });
    expect(out[0]!.id).toBe('eml_1');
    expect((out[0] as any).body_text).toBeUndefined();
    // received_at should be serialized to ISO string
    expect((out[0] as any).received_at).toBe('2026-06-07T00:00:00.000Z');
  });
});

describe('emailDao.insertAddress', () => {
  it('插入 localpart 行 (小写化 localpart)', async () => {
    const { db, captured } = mockDrizzleDb();
    const dao = makeEmailDao(db as any);
    await dao.insertAddress('u1', 'U-AbC123', '顺成贸易');
    expect(captured.insertedValues.localpart).toBe('u-abc123');
    expect(captured.insertedValues.user_id).toBe('u1');
    expect(captured.insertedValues.display_name).toBe('顺成贸易');
  });

  it('error → 抛出', async () => {
    const { db } = mockDrizzleDb({ insertError: new Error('duplicate key') });
    const dao = makeEmailDao(db as any);
    await expect(dao.insertAddress('u1', 'taken', null)).rejects.toThrow(/duplicate key/);
  });
});
