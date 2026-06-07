import { Router, type Router as RouterType, type Request, type Response, type RequestHandler } from 'express';
import type {
  EmailListResponse, EmailDetailResponse, EmailSendRequest, EmailSendResponse,
} from '@lingxi/shared';
import type { EmailDao } from '../db/email-dao.js';
import type { EmailProvider } from '../lib/email/index.js';

export interface EmailRouterConfig {
  domain: string;
  fromDefaultName: string;
  inboundWebhookSecret: string;
}

export interface EmailRouterDeps {
  dao: EmailDao;
  provider: EmailProvider;
  config: EmailRouterConfig;
  /** 容器 token 中间件 (塞 req.user_id) */
  containerAuth: RequestHandler;
  /** email entitlement gate (containerAuth 之后) */
  requireEmailEntitlement: RequestHandler;
}

const DEFAULT_LIST_LIMIT = 30;
const MAX_LIST_LIMIT = 100;

export const buildEmailRouter = (deps: EmailRouterDeps): RouterType => {
  const router = Router();
  const { dao, provider, config } = deps;

  // ---- 入站: Basic-Auth, 不走容器 token ----
  router.post('/api/email/inbound', async (req: Request, res: Response) => {
    // Basic-Auth: Authorization: Basic base64(user:pass), 校验 pass
    const auth = req.headers['authorization'] ?? '';
    let ok = false;
    if (auth.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
        const pass = decoded.slice(decoded.indexOf(':') + 1);
        ok = pass === config.inboundWebhookSecret;
      } catch { ok = false; }
    }
    if (!ok) {
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
      const userId = await dao.findUserByLocalpart(parsed.to_localpart);
      if (!userId) {
        // 未知收件人: 丢弃但回 202, 让服务商别重投/别报错
        res.status(202).json({ ok: true, dropped: 'unknown recipient' });
        return;
      }
      const id = await dao.insertInbound(parsed, userId);
      res.json({ ok: true, id });
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
        const emails = await dao.list(userId, { q, limit });
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
        const email = await dao.get(userId, id);
        if (!email) { res.status(404).json({ error: 'not found' }); return; }
        const body: EmailDetailResponse = { email };
        res.json(body);
      } catch (err) {
        res.status(500).json({ error: 'internal', message: String(err) });
      }
    });

  router.post('/api/email/send', deps.containerAuth, deps.requireEmailEntitlement,
    async (req: Request, res: Response) => {
      const userId = req.user_id!;
      const b = (req.body ?? {}) as EmailSendRequest;
      try {
        const addr = await dao.getAddress(userId);
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
          const orig = await dao.get(userId, b.in_reply_to_id);
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

        const id = await dao.insertOutbound({
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
