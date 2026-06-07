import type { ParsedInboundEmail } from '@lingxi/shared';
import type { EmailProvider, SendInput, SendResult } from './provider.js';

interface PostmarkAddr { Email?: string }
interface PostmarkHeader { Name?: string; Value?: string }

const localpartOf = (addr: string): string => addr.split('@')[0]!.trim().toLowerCase();
const headerOf = (headers: PostmarkHeader[], name: string): string | null => {
  const h = headers.find((x) => (x.Name ?? '').toLowerCase() === name.toLowerCase());
  return h?.Value ?? null;
};

export interface PostmarkConfig { serverToken: string }

export const makePostmarkProvider = (cfg: PostmarkConfig): EmailProvider => ({
  parseInbound(body: unknown): ParsedInboundEmail {
    const b = (body ?? {}) as Record<string, unknown>;
    const toFull = (b['ToFull'] as PostmarkAddr[] | undefined) ?? [];
    const ccFull = (b['CcFull'] as PostmarkAddr[] | undefined) ?? [];
    const headers = (b['Headers'] as PostmarkHeader[] | undefined) ?? [];
    const recipient = (b['OriginalRecipient'] as string | undefined)
      ?? toFull[0]?.Email ?? '';
    if (!recipient || !recipient.includes('@')) throw new Error('postmark inbound: no recipient');
    const refsRaw = headerOf(headers, 'References') ?? '';
    const attachments = (b['Attachments'] as unknown[] | undefined) ?? [];
    return {
      to_localpart: localpartOf(recipient),
      from_addr: (b['FromFull'] as PostmarkAddr | undefined)?.Email ?? String(b['From'] ?? ''),
      to_addrs: toFull.map((a) => a.Email ?? '').filter(Boolean),
      cc_addrs: ccFull.map((a) => a.Email ?? '').filter(Boolean),
      subject: String(b['Subject'] ?? ''),
      message_id: b['MessageID'] ? String(b['MessageID']) : null,
      in_reply_to: headerOf(headers, 'In-Reply-To'),
      reference_ids: refsRaw.split(/\s+/).map((s) => s.trim()).filter(Boolean),
      // StrippedTextReply 去掉了引用历史, 优先; 没有则退回 TextBody
      body_text: String(b['StrippedTextReply'] ?? b['TextBody'] ?? ''),
      has_attachments: attachments.length > 0,
    };
  },

  async send(input: SendInput): Promise<SendResult> {
    const headers: PostmarkHeader[] = [];
    if (input.in_reply_to) headers.push({ Name: 'In-Reply-To', Value: input.in_reply_to });
    if (input.reference_ids?.length) {
      headers.push({ Name: 'References', Value: input.reference_ids.join(' ') });
    }
    const resp = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Postmark-Server-Token': cfg.serverToken,
      },
      body: JSON.stringify({
        From: `${input.from_name} <${input.from_addr}>`,
        To: input.to.join(', '),
        Cc: input.cc.length ? input.cc.join(', ') : undefined,
        Subject: input.subject,
        TextBody: input.body_text,
        Headers: headers,
        MessageStream: 'outbound',
      }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error(`postmark send failed ${resp.status}: ${t}`);
    }
    const json = await resp.json() as { MessageID?: string };
    return { message_id: json.MessageID ?? '' };
  },
});
