import { Router, type Request, type Response, type Router as RouterType, type RequestHandler } from 'express';
import type { PurchaseResponse } from '@lingxi/shared';
import { dao } from '../db/index.js';

export type ProvisionerFn = (args: { userId: string; containerName: string; shareName: string }) => Promise<void>;

const shortHash = (userId: string): string => userId.replace(/-/g, '').slice(0, 8);

export const buildPurchaseRouter = (
  provisioner: ProvisionerFn,
  sessionMw: RequestHandler,
): RouterType => {
  const router = Router();

  router.post('/api/purchase', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const hash = shortHash(userId);
    const containerName = `hermes-${hash}`;
    const shareName = `user-${hash}`;

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

    provisioner({ userId, containerName, shareName }).catch((err) => {
      console.error(`[purchase] provisioner error for ${userId}:`, err);
    });

    const body: PurchaseResponse = { user_id: userId, status: 'provisioning' };
    res.json(body);
  });

  return router;
};
