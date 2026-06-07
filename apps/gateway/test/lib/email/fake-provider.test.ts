import { describe, it, expect } from 'vitest';
import { makeFakeProvider } from '../../../src/lib/email/fake-provider.js';

const provider = makeFakeProvider();

describe('fakeProvider.parseInbound', () => {
  it('从简单 JSON 解析出中立结构', () => {
    const parsed = provider.parseInbound({
      to: 'sunco@mail.localhost',
      from: 'bob@supplier.com',
      subject: '报价',
      text: '请确认',
      message_id: '<m1@supplier.com>',
    });
    expect(parsed.to_localpart).toBe('sunco');
    expect(parsed.from_addr).toBe('bob@supplier.com');
    expect(parsed.subject).toBe('报价');
    expect(parsed.body_text).toBe('请确认');
    expect(parsed.message_id).toBe('<m1@supplier.com>');
    expect(parsed.to_addrs).toEqual(['sunco@mail.localhost']);
  });

  it('缺收件人 → 抛错', () => {
    expect(() => provider.parseInbound({ from: 'a@b.com' })).toThrow();
  });
});

describe('fakeProvider.send', () => {
  it('返回合成 message_id, 不真发', async () => {
    const r = await provider.send({
      from_addr: 'sunco@mail.localhost', from_name: '灵犀',
      to: ['bob@supplier.com'], cc: [], subject: 'Re: 报价', body_text: '同意',
    });
    expect(r.message_id).toMatch(/@mail\.localhost>$/);
  });
});
