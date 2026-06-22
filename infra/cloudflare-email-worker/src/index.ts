import PostalMime from 'postal-mime';

interface Env {
  GATEWAY_URL: string;
  INBOUND_WEBHOOK_SECRET: string;
  ROUTES: KVNamespace; // 入站回调 override 表: localpart → gateway base URL(测试环境用,见 README)
}

/**
 * Cloudflare Email Worker (入站附件版)。
 * uncagedai.org 的 catch-all 把每封入站邮件交到这里:
 *   1. postal-mime 解 MIME → 规整 JSON
 *   2. 若有附件: prepare → PUT blob → commit (附件 keys)
 *      否则: 直接 commit
 *   3. 任何失败 → setReject 让发件方 MTA 重投
 * gateway 按 to 的 localpart 找用户、落库。
 *
 * 出站不在这里 (走 Resend)。本 Worker 只管收。
 */
export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    try {
      const email = await PostalMime.parse(message.raw);
      const auth = 'Basic ' + btoa(`cf:${env.INBOUND_WEBHOOK_SECRET}`);
      const toLocalpart = (message.to.split('@')[0] || '').toLowerCase();
      // 入站回调分发: KV 里若有该 localpart 的 override(测试/本地调试用),走它;否则走默认 GATEWAY_URL(线上)。
      // 加/删 override 用 `wrangler kv key put/delete`(见 README),改完即时生效,无需重部署。
      const override = await env.ROUTES.get(`to:${toLocalpart}`);
      const base = override ?? env.GATEWAY_URL;
      const atts = email.attachments ?? [];

      let attachmentKeys: Array<{ key: string; filename: string; content_type: string; size: number }> = [];

      if (atts.length > 0) {
        // 1. prepare
        const prep = await fetch(`${base}/api/email/inbound/prepare`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: auth },
          body: JSON.stringify({
            to_localpart: toLocalpart,
            attachments: atts.map((a) => ({
              filename: a.filename ?? 'attachment',
              content_type: a.mimeType ?? 'application/octet-stream',
              size: (a.content as ArrayBuffer).byteLength,
            })),
          }),
        });
        if (!prep.ok) throw new Error(`prepare ${prep.status}`);
        const pj = await prep.json() as { recipient: string; uploads?: Array<{ idx: number; key: string; sas_url: string }> };
        if (pj.recipient === 'unknown') {
          console.log(`[email-worker] drop unknown recipient ${message.to}`);
          return; // 未知收件人:丢弃,不上传不 commit
        }
        // 2. 上传每个附件
        for (const u of pj.uploads ?? []) {
          const a = atts[u.idx]!;
          const put = await fetch(u.sas_url, {
            method: 'PUT',
            headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': a.mimeType ?? 'application/octet-stream' },
            body: a.content as ArrayBuffer,
          });
          if (!put.ok) throw new Error(`blob PUT ${put.status}`);
          attachmentKeys.push({
            key: u.key, filename: a.filename ?? 'attachment',
            content_type: a.mimeType ?? 'application/octet-stream',
            size: (a.content as ArrayBuffer).byteLength,
          });
        }
      }

      // 3. commit
      const refs = (email.references ?? '').split(/\s+/).map((s) => s.trim()).filter(Boolean);
      const payload = {
        // 信封收件人 = 实际投递到的 catch-all 地址, 决定属于哪个助手 (比 To 头可靠)
        to: message.to,
        from_addr: email.from?.address ?? message.from,
        to_addrs: (email.to ?? []).map((a) => a.address).filter(Boolean),
        cc_addrs: (email.cc ?? []).map((a) => a.address).filter(Boolean),
        subject: email.subject ?? '',
        message_id: email.messageId ?? null,
        in_reply_to: email.inReplyTo ?? null,
        reference_ids: refs,
        text: email.text ?? '',
        attachment_keys: attachmentKeys,
      };
      const resp = await fetch(`${base}/api/email/inbound`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify(payload),
      });
      // gateway 200=已落库 202=未知收件人已丢弃, 两者都算成功
      if (!resp.ok && resp.status !== 202) throw new Error(`commit ${resp.status}`);
    } catch (err) {
      console.error(`[email-worker] failed for ${message.to}: ${err}`);
      message.setReject('temporary failure, please retry'); // 让发件方 MTA 重投
    }
  },
};
