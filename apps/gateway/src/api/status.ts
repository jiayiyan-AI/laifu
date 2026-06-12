import { Router, type Request, type Response, type Router as RouterType, type RequestHandler } from 'express';
import type { StatusResponse } from '@lingxi/shared';
import { dao } from '../db/index.js';

export const buildStatusRouter = (
  sessionMw: RequestHandler,
): RouterType => {
  const router = Router();

  router.get('/api/status', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const row = dao.cache.get(userId);
    if (!row) {
      res.status(404).json({ error: 'no container mapping' });
      return;
    }

    const [desired, observed, tv] = await Promise.all([
      dao.entitlements.listActive(userId),
      dao.observedState.get(userId),
      dao.entitlements.getTokenVersion(userId),
    ]);

    const body: StatusResponse = {
      status: row.status,
      provisioning_step: row.provisioning_step,
      progress_pct: row.progress_pct,
      error_message: row.error_message,
      entitlements_desired: desired,
      entitlements_observed: observed?.observed_entitlements ?? [],
      container_token_version: tv ?? 0,
    };
    res.json(body);
  });

  return router;
};
