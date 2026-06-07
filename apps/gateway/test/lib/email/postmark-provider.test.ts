import { describe, it, expect, vi, afterEach } from 'vitest';
import { makePostmarkProvider } from '../../../src/lib/email/postmark-provider.js';

const provider = makePostmarkProvider({ serverToken: 'tok' });

describe('postmarkProvider.parseInbound', () => {
  it('解析 Postmark inbound JSON, 取 StrippedTextReply 优先', () => {
    const parsed = provider.parseInbound({
      OriginalRecipient: 'sunco@mail.lingxi.xxx',
      FromFull: { Email: 'bob@supplier.com' },
      ToFull: [{ Email: 'sunco@mail.lingxi.xxx' }],
      CcFull: [],
      Subject: '报价',
      TextBody: '请确认\n> 历史引用',
      StrippedTextReply: '请确认',
      MessageID: 'm1',
      Headers: [{ Name: 'In-Reply-To', Value: '<x@y>' }, { Name: 'References', Value: '<a@b> <c@d>' }],
      Attachments: [],
    });
    expect(parsed.to_localpart).toBe('sunco');
    expect(parsed.from_addr).toBe('bob@supplier.com');
    expect(parsed.body_text).toBe('请确认');                 // StrippedTextReply 优先
    expect(parsed.in_reply_to).toBe('<x@y>');
    expect(parsed.reference_ids).toEqual(['<a@b>', '<c@d>']);
  });
});

describe('postmarkProvider.send', () => {
  afterEach(() => vi.restoreAllMocks());
  it('POST /email 带 server token + 线程 Headers, 返回 MessageID', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ MessageID: 'sent-123' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await provider.send({
      from_addr: 'sunco@mail.lingxi.xxx', from_name: '灵犀',
      to: ['bob@supplier.com'], cc: [], subject: 'Re: 报价', body_text: '同意',
      in_reply_to: '<m1@x>', reference_ids: ['<m1@x>'],
    });
    expect(r.message_id).toBe('sent-123');
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.postmarkapp.com/email');
    expect((opts as any).headers['X-Postmark-Server-Token']).toBe('tok');
    const body = JSON.parse((opts as any).body);
    expect(body.From).toBe('灵犀 <sunco@mail.lingxi.xxx>');
    expect(body.Headers).toEqual(expect.arrayContaining([{ Name: 'In-Reply-To', Value: '<m1@x>' }]));
  });

  it('Postmark 返回非 ok → 抛错', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 422, text: async () => 'bad' }));
    await expect(provider.send({
      from_addr: 'a@b', from_name: 'x', to: ['c@d'], cc: [], subject: 's', body_text: 'b',
    })).rejects.toThrow(/422/);
  });
});
