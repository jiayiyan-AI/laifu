import type { ParsedInboundEmail } from '@lingxi/shared';
import type { EmailProvider, SendInput, SendResult } from './provider.js';

const localpartOf = (addr: string): string => addr.split('@')[0]!.trim().toLowerCase();
const asArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : [];

/**
 * Dev fake: 入站吃一个简单 JSON {to, from, subject, text, ...}; 出站不真发,
 * 合成一个 Message-ID 返回 (由 send 调用方落 outbound 行)。
 * 让本地不依赖 Postmark/域名/DNS 就能跑通整条收发链路。
 */
export const makeFakeProvider = (): EmailProvider => ({
  parseInbound(body: unknown): ParsedInboundEmail {
    const b = (body ?? {}) as Record<string, unknown>;
    const to = typeof b['to'] === 'string' ? (b['to'] as string) : asArray(b['to'])[0] ?? '';
    if (!to || !to.includes('@')) throw new Error('fake inbound: missing/invalid "to"');
    const refs = asArray(b['reference_ids'] ?? b['references']);
    return {
      to_localpart: localpartOf(to),
      from_addr: String(b['from'] ?? ''),
      to_addrs: asArray(b['to']).length ? asArray(b['to']) : [to],
      cc_addrs: asArray(b['cc']),
      subject: String(b['subject'] ?? ''),
      message_id: b['message_id'] ? String(b['message_id']) : null,
      in_reply_to: b['in_reply_to'] ? String(b['in_reply_to']) : null,
      reference_ids: refs,
      body_text: String(b['text'] ?? b['body_text'] ?? ''),
      has_attachments: false,
    };
  },

  async send(input: SendInput): Promise<SendResult> {
    // 合成一个稳定形态的 Message-ID; 用 from 域名后缀, 不依赖随机时间 (测试可断言后缀)
    const rand = Math.random().toString(36).slice(2, 10);
    const domain = input.from_addr.split('@')[1] ?? 'mail.localhost';
    const message_id = `<${rand}@${domain}>`;
    console.log(`[email/fake] (not really sending) to=${input.to.join(',')} subj="${input.subject}" → ${message_id}`);
    return { message_id };
  },
});
