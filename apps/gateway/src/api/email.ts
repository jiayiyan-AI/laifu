import { Router, type Router as RouterType, type Request, type Response, type RequestHandler } from 'express';
import type {
  EmailListResponse, EmailDetailResponse, EmailSendRequest, EmailSendResponse,
  AttachmentRef,
} from '@lingxi/shared';
import { dao } from '../db/index.js';
import type { EmailProvider } from '../lib/email/index.js';
import { log } from '../lib/logger.js';
import { buildWriteBlobSas, buildReadBlobSas } from '../lib/sas-builder.js';
import { buildContentDisposition } from '../lib/content-disposition.js';
import type { UserDelegationKeyCache } from '../lib/user-delegation-key-cache.js';
import { randomUUID } from 'node:crypto';

export interface EmailRouterConfig {
  domain: string;
  fromDefaultName: string;
  inboundWebhookSecret: string;
}

export interface EmailRouterDeps {
  provider: EmailProvider;
  config: EmailRouterConfig;
  /** 容器 token 中间件 (塞 req.user_id) */
  containerAuth: RequestHandler;
  /** email entitlement gate (containerAuth 之后) */
  requireEmailEntitlement: RequestHandler;
  /** 附件存储依赖;未配置(无 Azure)时附件相关端点回 501 */
  attachments?: {
    udkCache: Pick<UserDelegationKeyCache, 'get'>;
    accountName: string;
    container: string;       // email-attachments
    blobEndpoint: string;
    writeSasTtlSeconds: number;
    readSasTtlSeconds: number;
  };
}

const DEFAULT_LIST_LIMIT = 30;
const MAX_LIST_LIMIT = 100;

export const buildEmailRouter = (deps: EmailRouterDeps): RouterType => {
  const router = Router();
  const { provider, config } = deps;

  // Basic-Auth 校验辅助: inbound + prepare 共用
  const checkInboundAuth = (req: Request): boolean => {
    const auth = req.headers['authorization'] ?? '';
    if (!auth.startsWith('Basic ')) return false;
    try {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const pass = decoded.slice(decoded.indexOf(':') + 1);
      return pass === config.inboundWebhookSecret;
    } catch { return false; }
  };

  // ---- 入站: Basic-Auth, 不走容器 token ----
  router.post('/api/email/inbound', async (req: Request, res: Response) => {
    if (!checkInboundAuth(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    let parsed;
    try {
      parsed = provider.parseInbound(req.body);
    } catch (err) {
      res.status(400).json({ error: 'parse failed', message: String(err) });
      return;
    }

    try {
      const userId = await dao.email.findUserByLocalpart(parsed.to_localpart);
      if (!userId) {
        // 未知收件人: 丢弃但回 202 (服务商别重投/别弹退信)。202 是成功码, Worker 不会报错,
        // 故必须在这里记日志, 否则静默丢失 (排查"邮件没到"时无从下手)。
        log.warn({
          event: 'email.inbound.drop',
          reason: 'unknown_recipient',
          to_localpart: parsed.to_localpart,
          from: parsed.from_addr,
          subject: parsed.subject,
        });
        res.status(202).json({ ok: true, dropped: 'unknown recipient' });
        return;
      }
      const id = await dao.email.insertInbound(parsed, userId);
      log.info({
        event: 'email.inbound.received',
        id, to_localpart: parsed.to_localpart, from: parsed.from_addr,
      });
      res.json({ ok: true, id });
    } catch (err) {
      res.status(500).json({ error: 'internal', message: String(err) });
    }
  });

  // ---- 入站附件 prepare: 查收件人归属, 已知则为每附件签 write-SAS ----
  router.post('/api/email/inbound/prepare', async (req: Request, res: Response) => {
    if (!checkInboundAuth(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const att = deps.attachments;
    if (!att) { res.status(501).json({ error: 'attachments not configured' }); return; }

    const body = (req.body ?? {}) as { to_localpart?: string; attachments?: Array<{ filename?: string; content_type?: string; size?: number }> };
    const localpart = String(body.to_localpart ?? '').trim().toLowerCase();
    const list = Array.isArray(body.attachments) ? body.attachments : [];
    if (!localpart) { res.status(400).json({ error: 'to_localpart required' }); return; }

    try {
      const userId = await dao.email.findUserByLocalpart(localpart);
      if (!userId) {
        log.warn({ event: 'email.inbound.drop', reason: 'unknown_recipient', to_localpart: localpart, phase: 'prepare' });
        res.status(200).json({ recipient: 'unknown' });
        return;
      }
      if (list.length === 0) {
        res.status(200).json({ recipient: 'ok', uploads: [] });
        return;
      }
      const udk = await att.udkCache.get();
      // 收件人 handle 做一级目录, 便于运维/门户按 handle 浏览;localpart 已匹配 DB 行,
      // 仍防御性去掉路径分隔符。隔离仍靠 DB+gateway, 不靠此路径。
      const dir = localpart.replace(/[/\\]/g, '_');
      const uploads = list.map((a, idx) => {
        const safe = safeFilename(a.filename) || `attachment-${idx}`;
        const key = `${dir}/${randomUUID()}-${safe}`;
        const sas = buildWriteBlobSas({
          account: att.accountName, container: att.container, blobName: key,
          udk, ttlSeconds: att.writeSasTtlSeconds,
        });
        const url = `${att.blobEndpoint}/${att.container}/${key.split('/').map(encodeURIComponent).join('/')}?${sas.sasToken}`;
        return { idx, key, sas_url: url };
      });
      res.status(200).json({ recipient: 'ok', uploads });
    } catch (err) {
      res.status(500).json({ error: 'internal', message: String(err) });
    }
  });

  // ---- 以下走 containerAuth + email entitlement ----
  router.get('/api/email/list', deps.containerAuth, deps.requireEmailEntitlement,
    async (req: Request, res: Response) => {
      const userId = req.user_id!;
      const q = (req.query['q'] as string | undefined)?.trim() || undefined;
      const rawLimit = parseInt((req.query['limit'] as string) ?? '', 10);
      const limit = Number.isFinite(rawLimit)
        ? Math.min(Math.max(rawLimit, 1), MAX_LIST_LIMIT)
        : DEFAULT_LIST_LIMIT;
      try {
        const emails = await dao.email.list(userId, { q, limit });
        const body: EmailListResponse = { emails };
        res.json(body);
      } catch (err) {
        res.status(500).json({ error: 'internal', message: String(err) });
      }
    });

  router.get('/api/email/get', deps.containerAuth, deps.requireEmailEntitlement,
    async (req: Request, res: Response) => {
      const userId = req.user_id!;
      const id = req.query['id'] as string | undefined;
      if (!id) { res.status(400).json({ error: 'id required' }); return; }
      try {
        const email = await dao.email.get(userId, id);
        if (!email) { res.status(404).json({ error: 'not found' }); return; }
        const body: EmailDetailResponse = { email };
        res.json(body);
      } catch (err) {
        res.status(500).json({ error: 'internal', message: String(err) });
      }
    });

  // ---- 附件下载: 属主校验(dao.email.get 按 user_id 过滤)→ 签 read-SAS 302 ----
  router.get('/api/email/attachment', deps.containerAuth, deps.requireEmailEntitlement,
    async (req: Request, res: Response) => {
      const att = deps.attachments;
      if (!att) { res.status(501).json({ error: 'attachments not configured' }); return; }
      const userId = req.user_id!;
      const id = String(req.query['id'] ?? '');
      const idx = parseInt(String(req.query['idx'] ?? ''), 10);
      if (!id || !Number.isInteger(idx) || idx < 0) { res.status(400).json({ error: 'id + idx required' }); return; }
      try {
        const email = await dao.email.get(userId, id);   // 已按 user_id 过滤
        const ref: AttachmentRef | undefined = email?.attachment_keys?.[idx];
        if (!ref) { res.status(404).json({ error: 'attachment not found' }); return; }
        const udk = await att.udkCache.get();
        const sas = buildReadBlobSas({
          account: att.accountName, container: att.container, blobName: ref.key,
          udk, ttlSeconds: att.readSasTtlSeconds,
          contentDisposition: buildContentDisposition('attachment', ref.filename),
        });
        const encoded = ref.key.split('/').map(encodeURIComponent).join('/');
        res.redirect(302, `${att.blobEndpoint}/${att.container}/${encoded}?${sas.sasToken}`);
      } catch (err) {
        res.status(500).json({ error: 'internal', message: String(err) });
      }
    });

  router.post('/api/email/send', deps.containerAuth, deps.requireEmailEntitlement,
    async (req: Request, res: Response) => {
      const userId = req.user_id!;
      const b = (req.body ?? {}) as EmailSendRequest;
      try {
        const addr = await dao.email.getAddress(userId);
        if (!addr) { res.status(409).json({ error: 'no email address provisioned' }); return; }
        const fromAddr = `${addr.localpart}@${config.domain}`;
        const fromName = addr.display_name || config.fromDefaultName;

        // 线程: 给定 in_reply_to_id 时取原邮件
        let to = Array.isArray(b.to) ? b.to.filter(Boolean) : [];
        let cc = Array.isArray(b.cc) ? b.cc.filter(Boolean) : [];
        let inReplyTo: string | null = null;
        let references: string[] = [];
        let subject = b.subject ?? '';

        if (b.in_reply_to_id) {
          const orig = await dao.email.get(userId, b.in_reply_to_id);
          if (!orig) { res.status(404).json({ error: 'in_reply_to_id not found' }); return; }
          if (to.length === 0) to = [orig.from_addr];          // 默认回原发件人
          inReplyTo = orig.message_id;
          references = [...orig.reference_ids, ...(orig.message_id ? [orig.message_id] : [])];
          if (!subject) subject = orig.subject.startsWith('Re:') ? orig.subject : `Re: ${orig.subject}`;
        }

        if (to.length === 0) {
          res.status(400).json({ error: 'to required (or give in_reply_to_id)' });
          return;
        }

        const { message_id } = await provider.send({
          from_addr: fromAddr, from_name: fromName,
          to, cc, subject, body_text: b.body_text ?? '',
          in_reply_to: inReplyTo ?? undefined,
          reference_ids: references,
        });

        const id = await dao.email.insertOutbound({
          user_id: userId, from_addr: fromAddr, to_addrs: to, cc_addrs: cc,
          subject, message_id, in_reply_to: inReplyTo, reference_ids: references,
          body_text: b.body_text ?? '',
        });

        const out: EmailSendResponse = { ok: true, id, message_id };
        res.json(out);
      } catch (err) {
        res.status(500).json({ error: 'internal', message: String(err) });
      }
    });

  return router;
};

/** email entitlement gate: containerAuth 之后用, 查 user 是否 active 'email'. */
export const makeEmailEntitlementMiddleware = (): RequestHandler => async (req, res, next) => {
  const userId = req.user_id!;
  try {
    const active = await dao.entitlements.listActive(userId);
    if (!active.includes('email')) {
      res.status(403).json({ error: 'email entitlement not active' });
      return;
    }
    next();
  } catch (err) {
    res.status(500).json({ error: 'internal', message: String(err) });
  }
};

function safeFilename(name: string | undefined): string {
  const base = (name ?? '').replace(/[/\\]/g, '_').replace(/[\x00-\x1f]/g, '').trim();
  return base.slice(0, 200);
}
