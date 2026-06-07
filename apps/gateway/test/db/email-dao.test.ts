import { describe, it, expect, vi } from 'vitest';
import { makeEmailDao } from '../../src/db/email-dao.js';

// 链式 mock: from().select().eq()...; 每个方法返回 self, 末端 await 返回 result。
function mockSb(result: any) {
  const calls: any = { filters: {} };
  const chain: any = {
    from: vi.fn(() => chain),
    select: vi.fn(() => chain),
    insert: vi.fn((row: any) => { calls.inserted = row; return chain; }),
    eq: vi.fn((k: string, v: any) => { calls.filters[k] = v; return chain; }),
    is: vi.fn(() => chain),
    or: vi.fn((expr: string) => { calls.or = expr; return chain; }),
    order: vi.fn(() => chain),
    limit: vi.fn((n: number) => { calls.limit = n; return chain; }),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then: (resolve: any) => resolve(result),
  };
  return { chain, calls };
}

describe('emailDao.findUserByLocalpart', () => {
  it('查到 → 返回 user_id', async () => {
    const { chain, calls } = mockSb({ data: { user_id: 'u1' }, error: null });
    const dao = makeEmailDao(chain as any);
    const uid = await dao.findUserByLocalpart('sunco');
    expect(uid).toBe('u1');
    expect(calls.filters['localpart']).toBe('sunco');
  });
  it('查不到 → null', async () => {
    const { chain } = mockSb({ data: null, error: null });
    const dao = makeEmailDao(chain as any);
    expect(await dao.findUserByLocalpart('nope')).toBeNull();
  });
});

describe('emailDao.insertInbound', () => {
  it('落 inbound 行, 生成 eml_ id', async () => {
    const { chain, calls } = mockSb({ data: null, error: null });
    const dao = makeEmailDao(chain as any);
    const id = await dao.insertInbound({
      to_localpart: 'sunco', from_addr: 'bob@x.com', to_addrs: ['sunco@m'], cc_addrs: [],
      subject: '报价', message_id: '<m1>', in_reply_to: null, reference_ids: [],
      body_text: '请确认', has_attachments: false,
    }, 'u1');
    expect(id).toMatch(/^eml_/);
    expect(calls.inserted.direction).toBe('inbound');
    expect(calls.inserted.user_id).toBe('u1');
    expect(calls.inserted.from_addr).toBe('bob@x.com');
  });
});

describe('emailDao.list', () => {
  it('映射成 EmailListItem (不含正文)', async () => {
    const rows = [{
      id: 'eml_1', direction: 'inbound', from_addr: 'b@x', to_addrs: ['s@m'],
      subject: '报价', has_attachments: false, received_at: '2026-06-07T00:00:00Z',
    }];
    const { chain, calls } = mockSb({ data: rows, error: null });
    const dao = makeEmailDao(chain as any);
    const out = await dao.list('u1', { limit: 10 });
    expect(out[0]!.id).toBe('eml_1');
    expect((out[0] as any).body_text).toBeUndefined();
    expect(calls.filters['user_id']).toBe('u1');
    expect(calls.limit).toBe(10);
  });
});

describe('emailDao.insertAddress', () => {
  it('插入 localpart 行 (小写化 localpart)', async () => {
    const { chain, calls } = mockSb({ data: null, error: null });
    const dao = makeEmailDao(chain as any);
    await dao.insertAddress('u1', 'U-AbC123', '顺成贸易');
    expect(calls.inserted.localpart).toBe('u-abc123');
    expect(calls.inserted.user_id).toBe('u1');
    expect(calls.inserted.display_name).toBe('顺成贸易');
  });

  it('error → 抛出', async () => {
    const { chain } = mockSb({ data: null, error: { message: 'duplicate key', code: '23505' } });
    const dao = makeEmailDao(chain as any);
    await expect(dao.insertAddress('u1', 'taken', null)).rejects.toThrow(/insertAddress/);
  });
});
