import { Router, type Router as RouterType, type Request, type Response, type RequestHandler } from 'express';
import type { EntitlementsDao } from '../db/entitlements-dao.js';
import type { EntitlementChangeResponse } from '@lingxi/shared';
import { MANAGEABLE_FEATURES } from '@lingxi/shared';

/** 允许通过此端点开关的能力。新增能力时在此追加(与前端 catalog 同步)。 */
// 白名单派生自 @lingxi/shared 单一来源, 避免与前端 catalog 漂移 (见 capabilities.test.ts)。
const ALLOWED_FEATURES = new Set<string>(MANAGEABLE_FEATURES);

export interface EntitlementsRouterDeps {
  entitlements: EntitlementsDao;
  /** Trigger a container restart for the user (ACA restartRevision or local mock). */
  restartContainer: (userId: string) => Promise<void>;
  /**
   * Sign a new LAIFU_USER_TOKEN using the new token_version, and write it
   * to the container's env / secret store so the next start picks it up.
   */
  signTokenAndInject: (userId: string, tokenVersion: number) => Promise<void>;
  sessionMw: RequestHandler;
}

export const buildEntitlementsRouter = (deps: EntitlementsRouterDeps): RouterType => {
  const router = Router();

  // enable / disable 几乎同形,DRY 成一个 handler 工厂。
  const makeHandler = (kind: 'enable' | 'disable'): RequestHandler => async (req: Request, res: Response) => {
    const feature = req.params['feature'] as string;
    if (!ALLOWED_FEATURES.has(feature)) {
      res.status(404).json({ error: `unknown feature: ${feature}` });
      return;
    }
    const userId = req.session!.user_id;
    try {
      const { changed } = kind === 'enable'
        ? await deps.entitlements.enable(userId, feature)
        : await deps.entitlements.disable(userId, feature);

      // Idempotent: 即使 already-active/inactive 也强制 re-sync 容器,避免 DB 和容器漂移。
      // - changed=true: bump token_version (撤销旧 token) + sign 新 token + restart
      // - changed=false: 不 bump (避免无意撤销并发实例),但仍 sign 当前 token + restart resync
      let tokenVersion: number;
      if (changed) {
        tokenVersion = await deps.entitlements.bumpTokenVersion(userId);
      } else {
        const current = await deps.entitlements.getTokenVersion(userId);
        tokenVersion = current ?? 0;
      }
      await deps.signTokenAndInject(userId, tokenVersion);
      // Fire-and-forget restart 让 API 快速返回;前端轮询 /api/status 知道容器何时回来。
      deps.restartContainer(userId).catch((err) => {
        console.error(`[entitlements] restart failed for ${userId}:`, err);
      });
      const active = await deps.entitlements.listActive(userId);
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
