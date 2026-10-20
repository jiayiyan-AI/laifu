import { describe, it, expect, vi } from 'vitest';
import { makeSystemMailer, resetLinkBase } from '../../../src/lib/email/system-mailer.js';

const fakeProvider = () => ({
  parseInbound: vi.fn(),
  send: vi.fn(async () => ({ message_id: '<x@d>' })),
});

describe('system-mailer', () => {
  it('sendPasswordReset: noreply 发件, 正文含链接与 30 分钟提示', async () => {
    const provider = fakeProvider();
    const m = makeSystemMailer({ provider, domain: 'mail.example.org', linkBase: 'https://app.example.org', logLinks: false });
    await m.sendPasswordReset('a@b.com', 'tok_ABC-_');
    const input = provider.send.mock.calls[0]![0] as any;
    expect(input.from_addr).toBe('noreply@mail.example.org');
    expect(input.from_name).toBe('灵犀');
    expect(input.to).toEqual(['a@b.com']);
    expect(input.cc).toEqual([]);
    expect(input.subject).toBe('重置你的灵犀密码');
    expect(input.body_text).toContain('https://app.example.org/reset-password?token=tok_ABC-_');
    expect(input.body_text).toContain('30 分钟');
  });

  it('resetLinkBase: frontendBaseUrl 优先, 为空回落 publicBaseUrl, 去尾斜杠', () => {
    expect(resetLinkBase({ frontendBaseUrl: 'https://f.org/', publicBaseUrl: 'https://p.org' })).toBe('https://f.org');
    expect(resetLinkBase({ frontendBaseUrl: '', publicBaseUrl: 'https://p.org/' })).toBe('https://p.org');
  });

  it('logLinks=true 时把链接打到日志(dev 冒烟用)', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const m = makeSystemMailer({ provider: fakeProvider(), domain: 'd', linkBase: 'http://localhost:3000', logLinks: true });
    await m.sendPasswordReset('a@b.com', 'tok1');
    expect(spy.mock.calls.flat().join(' ')).toContain('http://localhost:3000/reset-password?token=tok1');
    spy.mockRestore();
  });
});
