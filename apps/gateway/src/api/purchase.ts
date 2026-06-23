import { Router, type Request, type Response, type Router as RouterType, type RequestHandler } from 'express';
import {
  isValidAssistantName,
  isValidEmailLocalpart,
  type PurchaseErrorCode,
  type PurchaseRequest,
  type PurchaseResponse,
} from '@lingxi/shared';
import { dao } from '../db/index.js';
import { containerNameFor, shareNameFor } from '../provisioning/naming.js';
import { provisionUser } from '../provisioning/manager.js';
import { claimEmailAddress, EmailTakenError } from './email-provision.js';

/** 校验/冲突类响应统一带 code，前端据此给精确文案。 */
const fail = (res: Response, status: number, code: PurchaseErrorCode, error: string): Response => {
  console.warn(`[purchase] ${code} (${status}): ${error}`);
  return res.status(status).json({ error, code });
};

export const buildPurchaseRouter = (
  sessionMw: RequestHandler,
): RouterType => {
  const router = Router();

  router.post('/api/purchase', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const { assistant_name, email_localpart } = (req.body ?? {}) as Partial<PurchaseRequest>;
    if (!isValidAssistantName(assistant_name)) {
      return fail(res, 400, 'invalid_assistant_name', 'invalid assistant_name');
    }
    const assistantName = assistant_name.trim();

    // 邮箱前缀：用户自填则校验格式（小写后按字面校验）；留空 → 后端走 u-<hash> 默认。
    let localpart: string | undefined;
    const raw = typeof email_localpart === 'string' ? email_localpart.trim().toLowerCase() : '';
    if (raw) {
      if (!isValidEmailLocalpart(raw)) {
        return fail(res, 400, 'invalid_localpart', 'invalid email_localpart');
      }
      localpart = raw;
    }

    // 先认领专属邮箱：用户指定的前缀若被占用要如实报错，且此刻还没建 container_mapping，
    // 不会留下半残状态。非冲突的 DB 抖动不阻断激活（后续 ensure 会补）。
    try {
      await claimEmailAddress(userId, { localpart, displayName: assistantName });
    } catch (err) {
      if (err instanceof EmailTakenError) {
        return fail(res, 409, 'email_taken', `email localpart already taken: ${err.localpart}`);
      }
      console.error(`[purchase] email claim failed for ${userId}:`, err);
    }

    const containerName = containerNameFor(userId);
    const shareName = shareNameFor(userId);

    try {
      await dao.containerMapping.insert({
        user_id: userId,
        container_name: containerName,
        azure_files_share: shareName,
        status: 'provisioning',
        progress_pct: 0,
        assistant_name: assistantName,
      });
    } catch {
      // 重复 insert → 已有行，返回现有状态
      const existing = dao.cache.get(userId);
      if (existing) {
        const body: PurchaseResponse = { user_id: userId, status: existing.status };
        return res.json(body);
      }
      return res.status(500).json({ error: 'insert failed' });
    }

    const data = await dao.containerMapping.getByUserId(userId);
    if (data) dao.cache.set(data);

    provisionUser(userId).catch((err) => {
      console.error(`[purchase] provisioner error for ${userId}:`, err);
    });

    const body: PurchaseResponse = { user_id: userId, status: 'provisioning' };
    res.json(body);
  });

  return router;
};
