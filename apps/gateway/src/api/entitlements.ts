import { Router, type Router as RouterType, type Request, type Response, type RequestHandler } from 'express';
import type { EntitlementChangeResponse } from '@lingxi/shared';
import { MANAGEABLE_FEATURES } from '@lingxi/shared';
import { dao } from '../db/index.js';

/** 允许通过此端点开关的能力。新增能力时在此追加(与前端 catalog 同步)。 */
const ALLOWED_FEATURES = new Set<string>(MANAGEABLE_FEATURES);

import { syncUserContainer, resyncEntitlements } from '../provisioning/manager.js';

export interface EntitlementsRouterDeps {
  /** enable 成功后的可选副作用钩子(如 email 自动分配 handle)。失败不阻断装备。 */
  onEnable?: (userId: string, feature: string) => Promise<void>;
  sessionMw: RequestHandler;
}

export const buildEntitlementsRouter = (deps: EntitlementsRouterDeps): RouterType => {
  const router = Router();

  // enable: 纯加法, 不 bump token_version; 轻量 resync 推 desired 给热容器建软链 + 回报 observed (不滚 revision)。
  const enableHandler: RequestHandler = async (req: Request, res: Response) => {
    const feature = req.params['feature'] as string;
    if (!ALLOWED_FEATURES.has(feature)) {
      res.status(404).json({ error: `unknown feature: ${feature}` });
      return;
    }
    const userId = req.session!.user_id;
    try {
      const { changed } = await dao.entitlements.enable(userId, feature);
      if (deps.onEnable) {
        try {
          await deps.onEnable(userId, feature);
        } catch (err) {
          console.error(`[entitlements] onEnable hook failed for ${userId}/${feature}:`, err);
        }
      }
      // fire-and-forget: resync 在热容器上 ~1-2s 完成, 前端轮询 /api/status 看 observed 翻转。
      // 冷容器 / resync 失败时 desired 已落库, 容器 bootstrap 的 sync-entitlements 会自然收敛 (安全网)。
      void resyncEntitlements(userId).catch((err) =>
        console.error(`[entitlements] resync failed for ${userId}:`, err),
      );
      const active = await dao.entitlements.listActive(userId);
      const body: EntitlementChangeResponse = { ok: true, entitlements: active, changed };
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: 'internal', message: String(err) });
    }
  };

  // disable: 保留旧逻辑 —— bump token_version (顺带真吊销旧 token) + syncUserContainer (滚 revision 重投)。
  const disableHandler: RequestHandler = async (req: Request, res: Response) => {
    const feature = req.params['feature'] as string;
    if (!ALLOWED_FEATURES.has(feature)) {
      res.status(404).json({ error: `unknown feature: ${feature}` });
      return;
    }
    const userId = req.session!.user_id;
    try {
      const { changed } = await dao.entitlements.disable(userId, feature);
      if (changed) {
        await dao.entitlements.bumpTokenVersion(userId);
      }
      void syncUserContainer(userId).catch((err) =>
        console.error(`[entitlements] syncUserContainer failed for ${userId}:`, err),
      );
      const active = await dao.entitlements.listActive(userId);
      const body: EntitlementChangeResponse = { ok: true, entitlements: active, changed };
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: 'internal', message: String(err) });
    }
  };

  router.post('/api/entitlements/:feature/enable', deps.sessionMw, enableHandler);
  router.post('/api/entitlements/:feature/disable', deps.sessionMw, disableHandler);

  return router;
};
