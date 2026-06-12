import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeResendProvider } from '../../../src/lib/email/resend-provider.js';

const cfg = { apiKey: 'rk_test', domain: 'uncagedai.org' };

afterEach(() => { vi.restoreAllMocks(); });

describe('resend provider · parseInbound (CF Email Worker payload)', () => {
  const p = makeResendProvider(cfg);

  it('解析 Worker 规整 JSON, 取 localpart + 线程头', () => {
    const parsed = p.parseInbound({
      to: 'u-1a2b3c4d@uncagedai.org',
      from_addr: 'buyer@acme.com',
      to_addrs: ['u-1a2b3c4d@uncagedai.org'],
      cc_addrs: ['cc@acme.com'],
      subject: '报价确认',
      message_id: '<abc@acme.com>',
      in_reply_to: '<prev@uncagedai.org>',
      reference_ids: ['<r1>', '<r2>'],
      text: '请按附件确认',
      has_attachments: true,
    });
    expect(parsed.to_localpart).toBe('u-1a2b3c4d');
    expect(parsed.from_addr).toBe('buyer@acme.com');
    expect(parsed.cc_addrs).toEqual(['cc@acme.com']);
    expect(parsed.in_reply_to).toBe('<prev@uncagedai.org>');
    expect(parsed.reference_ids).toEqual(['<r1>', '<r2>']);
    expect(parsed.body_text).toBe('请按附件确认');
    expect(parsed.has_attachments).toBe(true);
  });

  it('无有效收件人时抛错', () => {
    expect(() => p.parseInbound({ from_addr: 'x@y.com' })).toThrow(/no.*recipient|invalid|missing/i);
  });

  it('解析 attachment_keys(Worker commit 带来的)', () => {
    const parsed = p.parseInbound({
      to: 'sunco@laifu.uncagedai.org', from_addr: 'b@x.com',
      subject: 's', text: 't',
      attachment_keys: [{ key: '01J-a.pdf', filename: 'a.pdf', content_type: 'application/pdf', size: 99 }],
    });
    expect(parsed.attachment_keys).toEqual([
      { key: '01J-a.pdf', filename: 'a.pdf', content_type: 'application/pdf', size: 99 },
    ]);
  });
  it('无 attachment_keys 时回 []', () => {
    const parsed = p.parseInbound({ to: 'sunco@laifu.uncagedai.org' });
    expect(parsed.attachment_keys).toEqual([]);
  });
});

describe('resend provider · send', () => {
  it('调 Resend API, 自生成 Message-ID 并带线程头, 返回该 Message-ID (非 Resend id)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'resend-uuid-xxxx' }), { status: 200 }),
    );
    const p = makeResendProvider(cfg);
    const { message_id } = await p.send({
      from_addr: 'u-1a2b3c4d@uncagedai.org',
      from_name: '顺',
      to: ['buyer@acme.com'],
      cc: [],
      subject: 'Re: 报价确认',
      body_text: '已确认',
      in_reply_to: '<abc@acme.com>',
      reference_ids: ['<abc@acme.com>'],
    });

    // 返回的是我们自己合成的 <uuid@domain>, 不是 Resend 的 id
    expect(message_id).toMatch(/^<[0-9a-f-]+@uncagedai\.org>$/);
    expect(message_id).not.toContain('resend-uuid');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect((init!.headers as Record<string, string>)['Authorization']).toBe('Bearer rk_test');
    const sent = JSON.parse(init!.body as string);
    expect(sent.from).toBe('顺 <u-1a2b3c4d@uncagedai.org>');
    expect(sent.to).toEqual(['buyer@acme.com']);
    expect(sent.cc).toBeUndefined();
    expect(sent.headers['In-Reply-To']).toBe('<abc@acme.com>');
    expect(sent.headers['References']).toBe('<abc@acme.com>');
    expect(sent.headers['Message-ID']).toBe(message_id);
  });

  it('非 2xx 抛错', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('rate limited', { status: 429 }),
    );
    const p = makeResendProvider(cfg);
    await expect(p.send({
      from_addr: 'a@uncagedai.org', from_name: 'a', to: ['b@x.com'], cc: [], subject: 's', body_text: 'b',
    })).rejects.toThrow(/resend send failed 429/);
  });
});
