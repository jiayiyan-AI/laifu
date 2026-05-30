import { Router, type Request, type Response } from 'express';
import type { ContainerMappingCache } from '../db/cache.js';
import type { StatusResponse } from '@lingxi/shared';

export const buildStatusRouter = (getCache: ContainerMappingCache | (() => ContainerMappingCache)): ReturnType<typeof Router> => {
  const router = Router();

  router.get('/api/status', (req: Request, res: Response) => {
    const userId = req.header('x-user-id');
    if (!userId) return res.status(400).json({ error: 'x-user-id required' });

    const cache = typeof getCache === 'function' ? getCache() : getCache;
    const row = cache.get(userId);
    if (!row) return res.status(404).json({ error: 'no container mapping' });

    const body: StatusResponse = {
      status: row.status,
      provisioning_step: row.provisioning_step,
      progress_pct: row.progress_pct,
      error_message: row.error_message,
    };
    res.json(body);
  });

  return router;
};
