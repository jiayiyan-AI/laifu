import PostalMime from 'postal-mime';

interface Env {
  GATEWAY_URL: string;
  INBOUND_WEBHOOK_SECRET: string;
}

/**
 * Cloudflare Email Worker (MVP 入站脑)。
 * uncagedai.org 的 catch-all 把每封入站邮件交到这里:
 *   1. postal-mime 解 MIME → 规整 JSON (字段对齐 gateway resend-provider.parseInbound)
 *   2. POST 到 gateway /api/email/inbound, Basic-Auth(pass=INBOUND_WEBHOOK_SECRET)
 * gateway 按 to 的 localpart 找用户、落库。
 *
 * 出站不在这里 (走 Resend)。本 Worker 只管收。
 */
export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const email = await PostalMime.parse(message.raw);

    const references = (email.references ?? '')
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);

    const payload = {
      // 信封收件人 = 实际投递到的 catch-all 地址, 决定属于哪个助手 (比 To 头可靠)
      to: message.to,
      from_addr: email.from?.address ?? message.from,
      to_addrs: (email.to ?? []).map((a) => a.address).filter(Boolean),
      cc_addrs: (email.cc ?? []).map((a) => a.address).filter(Boolean),
      subject: email.subject ?? '',
      message_id: email.messageId ?? null,
      in_reply_to: email.inReplyTo ?? null,
      reference_ids: references,
      text: email.text ?? '',
      has_attachments: (email.attachments ?? []).length > 0,
    };

    const auth = btoa(`cf:${env.INBOUND_WEBHOOK_SECRET}`);
    const resp = await fetch(`${env.GATEWAY_URL}/api/email/inbound`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(payload),
    });

    // gateway 对未知收件人回 202(丢弃), 对成功回 200。两者都算处理完。
    // 非 2xx (gateway 挂了/鉴权错) → 记日志, 让 Cloudflare 不投递到别处。
    // MVP 不 setReject (避免给发件人弹退信); 后续可改成 reject 让对方重试。
    if (!resp.ok) {
      console.error(`[email-worker] gateway inbound ${resp.status} for to=${message.to}`);
    }
  },
};
