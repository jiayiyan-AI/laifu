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
      // Idempotent: 即使 already-active 也强制 re-sync 容器,避免 DB 和容器漂移。
      // - changed=true: bump token_version (撤销旧 token) + sign 新 token + restart
      // - changed=false: 不 bump (避免无意撤销并发实例),但仍 sign 当前 token + restart,
      //   让容器有机会重跑 entrypoint 拉 entitlements + 软链 skill + 上报 observed。
      let tokenVersion: number;
      if (changed) {
        tokenVersion = await deps.entitlements.bumpTokenVersion(userId);
      } else {
        const current = await deps.entitlements.getTokenVersion(userId);
        tokenVersion = current ?? 0;
      }
      await deps.signTokenAndInject(userId, tokenVersion);
      // Fire-and-forget the restart so the API returns fast.
      // The front-end polls /api/status to know when the container actually came back up.
      deps.restartContainer(userId).catch((err) => {
        console.error(`[entitlements] restart failed for ${userId}:`, err);
      });
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
      // Idempotent: 跟 enable 同理。即使 already-disabled 也 re-sync 容器
      // (让 entrypoint 重跑,清掉残留的 skill 软链)。
      let tokenVersion: number;
      if (changed) {
        tokenVersion = await deps.entitlements.bumpTokenVersion(userId);
      } else {
        const current = await deps.entitlements.getTokenVersion(userId);
        tokenVersion = current ?? 0;
      }
      await deps.signTokenAndInject(userId, tokenVersion);
      deps.restartContainer(userId).catch((err) => {
        console.error(`[entitlements] restart failed for ${userId}:`, err);
      });
      const active = await deps.entitlements.listActive(userId);
      const body: EntitlementChangeResponse = { ok: true, entitlements: active, changed };
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: 'internal', message: String(err) });
    }
  });

  return router;
};
