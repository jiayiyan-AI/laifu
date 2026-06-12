import { randomUUID } from 'node:crypto';
import type { ParsedInboundEmail, AttachmentRef } from '@lingxi/shared';
import type { EmailProvider, SendInput, SendResult } from './provider.js';

const localpartOf = (addr: string): string => addr.split('@')[0]!.trim().toLowerCase();
const asArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : [];

export interface ResendConfig {
  apiKey: string;
  /** 助手邮箱域名, 用于合成出站 Message-ID (<uuid@domain>) */
  domain: string;
}

/**
 * MVP provider: 出站走 Resend 发信 API; 入站由 Cloudflare Email Worker 解析 MIME 后
 * POST 一份规整 JSON 到 /api/email/inbound, 故 parseInbound 只做透传 + 校验 (Worker 已是解析脑)。
 * 见 docs / memory: 入站=Cloudflare Routing, 出站=Resend(MVP 踏板, 生产规划切 SES)。
 */
export const makeResendProvider = (cfg: ResendConfig): EmailProvider => ({
  parseInbound(body: unknown): ParsedInboundEmail {
    // CF Email Worker 投递的规整 payload, 字段对齐 ParsedInboundEmail (见 worker 源码)
    const b = (body ?? {}) as Record<string, unknown>;
    const to = typeof b['to'] === 'string' ? (b['to'] as string) : asArray(b['to'])[0] ?? '';
    if (!to || !to.includes('@')) throw new Error('resend/cf inbound: missing/invalid "to"');
    const refs = asArray(b['reference_ids'] ?? b['references']);
    const toAddrs = asArray(b['to_addrs'] ?? b['to']);
    return {
      to_localpart: localpartOf(to),
      from_addr: String(b['from_addr'] ?? b['from'] ?? ''),
      to_addrs: toAddrs.length ? toAddrs : [to],
      cc_addrs: asArray(b['cc_addrs'] ?? b['cc']),
      subject: String(b['subject'] ?? ''),
      message_id: b['message_id'] ? String(b['message_id']) : null,
      in_reply_to: b['in_reply_to'] ? String(b['in_reply_to']) : null,
      reference_ids: refs,
      body_text: String(b['body_text'] ?? b['text'] ?? ''),
      has_attachments: Array.isArray(b['attachment_keys']) ? b['attachment_keys'].length > 0 : Boolean(b['has_attachments']),
      attachment_keys: Array.isArray(b['attachment_keys'])
        ? (b['attachment_keys'] as AttachmentRef[]).map((a) => ({
            key: String(a.key),
            filename: String(a.filename ?? 'attachment'),
            content_type: String(a.content_type ?? 'application/octet-stream'),
            size: Number(a.size ?? 0),
          }))
        : [],
    };
  },

  async send(input: SendInput): Promise<SendResult> {
    // Resend send 只回自家 UUID, 非 RFC Message-ID; 自己生成并经 headers 带出去, 保证线程头一致。
    const messageId = `<${randomUUID()}@${cfg.domain}>`;
    const headers: Record<string, string> = { 'Message-ID': messageId };
    if (input.in_reply_to) headers['In-Reply-To'] = input.in_reply_to;
    if (input.reference_ids?.length) headers['References'] = input.reference_ids.join(' ');

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        from: `${input.from_name} <${input.from_addr}>`,
        to: input.to,
        cc: input.cc.length ? input.cc : undefined,
        subject: input.subject,
        text: input.body_text,
        headers,
      }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error(`resend send failed ${resp.status}: ${t}`);
    }
    // 存我们自己生成的 Message-ID (而非 Resend 的 id), 供后续回信线程头引用。
    return { message_id: messageId };
  },
});
