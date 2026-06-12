import { Router, type Router as RouterType, type Request, type Response, type RequestHandler } from 'express';
import type { EntitlementChangeResponse } from '@lingxi/shared';
import { MANAGEABLE_FEATURES } from '@lingxi/shared';
import { dao } from '../db/index.js';

/** 允许通过此端点开关的能力。新增能力时在此追加(与前端 catalog 同步)。 */
const ALLOWED_FEATURES = new Set<string>(MANAGEABLE_FEATURES);

export interface EntitlementsRouterDeps {
  /** Trigger a container restart for the user (ACA restartRevision or local mock). */
  restartContainer: (userId: string) => Promise<void>;
  /**
   * Sign a new LAIFU_USER_TOKEN using the new token_version, and write it
   * to the container's env / secret store so the next start picks it up.
   */
  signTokenAndInject: (userId: string, tokenVersion: number) => Promise<void>;
  /** enable 成功后的可选副作用钩子(如 email 自动分配 handle)。失败不阻断装备。 */
  onEnable?: (userId: string, feature: string) => Promise<void>;
  sessionMw: RequestHandler;
}

export const buildEntitlementsRouter = (deps: EntitlementsRouterDeps): RouterType => {
  const router = Router();

  const makeHandler = (kind: 'enable' | 'disable'): RequestHandler => async (req: Request, res: Response) => {
    const feature = req.params['feature'] as string;
    if (!ALLOWED_FEATURES.has(feature)) {
      res.status(404).json({ error: `unknown feature: ${feature}` });
      return;
    }
    const userId = req.session!.user_id;
    try {
      const { changed } = kind === 'enable'
        ? await dao.entitlements.enable(userId, feature)
        : await dao.entitlements.disable(userId, feature);

      let tokenVersion: number;
      if (changed) {
        tokenVersion = await dao.entitlements.bumpTokenVersion(userId);
      } else {
        const current = await dao.entitlements.getTokenVersion(userId);
        tokenVersion = current ?? 0;
      }
      await deps.signTokenAndInject(userId, tokenVersion);
      if (kind === 'enable' && deps.onEnable) {
        try {
          await deps.onEnable(userId, feature);
        } catch (err) {
          console.error(`[entitlements] onEnable hook failed for ${userId}/${feature}:`, err);
        }
      }
      deps.restartContainer(userId).catch((err) => {
        console.error(`[entitlements] restart failed for ${userId}:`, err);
      });
      const active = await dao.entitlements.listActive(userId);
      const body: EntitlementChangeResponse = { ok: true, entitlements: active, changed };
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: 'internal', message: String(err) });
    }
  };

  router.post('/api/entitlements/:feature/enable', deps.sessionMw, makeHandler('enable'));
  router.post('/api/entitlements/:feature/disable', deps.sessionMw, makeHandler('disable'));

  return router;
};
