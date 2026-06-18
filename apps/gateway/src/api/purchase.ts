import { Router, type Request, type Response, type Router as RouterType, type RequestHandler } from 'express';
import type { PurchaseResponse } from '@lingxi/shared';
import { dao } from '../db/index.js';
import { containerNameFor, shareNameFor } from '../provisioning/naming.js';
import { provisionUser } from '../provisioning/manager.js';

export const buildPurchaseRouter = (
  sessionMw: RequestHandler,
): RouterType => {
  const router = Router();

  router.post('/api/purchase', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const containerName = containerNameFor(userId);
    const shareName = shareNameFor(userId);

    try {
      await dao.containerMapping.insert({
        user_id: userId,
        container_name: containerName,
        azure_files_share: shareName,
        status: 'provisioning',
        progress_pct: 0,
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
