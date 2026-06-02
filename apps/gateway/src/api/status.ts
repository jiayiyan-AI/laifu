import { Router, type Request, type Response, type Router as RouterType, type RequestHandler } from 'express';
import type { ContainerMappingCache } from '../db/cache.js';
import type { EntitlementsDao } from '../db/entitlements-dao.js';
import type { ObservedStateDao } from '../db/observed-state-dao.js';
import type { StatusResponse } from '@lingxi/shared';

export const buildStatusRouter = (
  cacheOrGetter: ContainerMappingCache | (() => ContainerMappingCache),
  sessionMw: RequestHandler,
  // OPTIONAL for backwards compat with the existing index.ts call.
  // Task 11 will pass these unconditionally and we'll keep them optional in the API
  // (no breaking change to any caller).
  entitlements?: Pick<EntitlementsDao, 'listActive' | 'getTokenVersion'>,
  observedState?: Pick<ObservedStateDao, 'get'>,
): RouterType => {
  const router = Router();
  const getCache = (): ContainerMappingCache =>
    typeof cacheOrGetter === 'function' ? cacheOrGetter() : cacheOrGetter;

  router.get('/api/status', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const row = getCache().get(userId);
    if (!row) {
      res.status(404).json({ error: 'no container mapping' });
      return;
    }

    // P1: 如果 DAO 被注入，合并 desired/observed entitlements + token_version
    let desired: string[] = [];
    let observedFeatures: string[] = [];
    let tokenVersion = 0;
    if (entitlements && observedState) {
      const [d, o, tv] = await Promise.all([
        entitlements.listActive(userId),
        observedState.get(userId),
        entitlements.getTokenVersion(userId),
      ]);
      desired = d;
      observedFeatures = o?.observed_entitlements ?? [];
      tokenVersion = tv ?? 0;
    }

    const body: StatusResponse = {
      status: row.status,
      provisioning_step: row.provisioning_step,
      progress_pct: row.progress_pct,
      error_message: row.error_message,
      entitlements_desired: desired,
      entitlements_observed: observedFeatures,
      container_token_version: tokenVersion,
    };
    res.json(body);
  });

  return router;
};
