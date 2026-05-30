import { Router, type Request, type Response, type Router as RouterType, type RequestHandler } from 'express';
import type { ContainerMappingCache } from '../db/cache.js';
import type { StatusResponse } from '@lingxi/shared';

export const buildStatusRouter = (
  cacheOrGetter: ContainerMappingCache | (() => ContainerMappingCache),
  sessionMw: RequestHandler,
): RouterType => {
  const router = Router();
  const getCache = (): ContainerMappingCache =>
    typeof cacheOrGetter === 'function' ? cacheOrGetter() : cacheOrGetter;

  router.get('/api/status', sessionMw, (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const row = getCache().get(userId);
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
