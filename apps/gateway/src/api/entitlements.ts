import { Router, type Router as RouterType, type Request, type Response, type RequestHandler } from 'express';
import type { EntitlementsDao } from '../db/entitlements-dao.js';
import type { EntitlementChangeResponse } from '@lingxi/shared';

const FEATURE = 'cloud';

export interface EntitlementsRouterDeps {
  entitlements: EntitlementsDao;
  /** Trigger a container restart for the user (ACA restartRevision or local mock). */
  restartContainer: (userId: string) => Promise<void>;
  /**
   * Sign a new LAIFU_USER_TOKEN using the new token_version, and write it
   * to the container's env / secret store so the next start picks it up.
   * Implemented in Task 10 (provisioning).
   */
  signTokenAndInject: (userId: string, tokenVersion: number) => Promise<void>;
  sessionMw: RequestHandler;
}

export const buildEntitlementsRouter = (deps: EntitlementsRouterDeps): RouterType => {
  const router = Router();

  router.post('/api/entitlements/cloud/enable', deps.sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    try {
      const { changed } = await deps.entitlements.enable(userId, FEATURE);
      if (changed) {
        const newVersion = await deps.entitlements.bumpTokenVersion(userId);
        await deps.signTokenAndInject(userId, newVersion);
        // Fire-and-forget the restart so the API returns fast.
        // The front-end polls /api/status to know when the container actually came back up.
        deps.restartContainer(userId).catch((err) => {
          console.error(`[entitlements] restart failed for ${userId}:`, err);
        });
      }
      const active = await deps.entitlements.listActive(userId);
      const body: EntitlementChangeResponse = { ok: true, entitlements: active, changed };
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: 'internal', message: String(err) });
    }
  });

  router.post('/api/entitlements/cloud/disable', deps.sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    try {
      const { changed } = await deps.entitlements.disable(userId, FEATURE);
      if (changed) {
        const newVersion = await deps.entitlements.bumpTokenVersion(userId);
        await deps.signTokenAndInject(userId, newVersion);
        deps.restartContainer(userId).catch((err) => {
          console.error(`[entitlements] restart failed for ${userId}:`, err);
        });
      }
      const active = await deps.entitlements.listActive(userId);
      const body: EntitlementChangeResponse = { ok: true, entitlements: active, changed };
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: 'internal', message: String(err) });
    }
  });

  return router;
};
