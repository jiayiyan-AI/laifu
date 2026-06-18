import { Router, type Router as RouterType, type Request, type Response, type RequestHandler } from 'express';
import type { EntitlementChangeResponse } from '@lingxi/shared';
import { MANAGEABLE_FEATURES } from '@lingxi/shared';
import { dao } from '../db/index.js';

/** 允许通过此端点开关的能力。新增能力时在此追加(与前端 catalog 同步)。 */
const ALLOWED_FEATURES = new Set<string>(MANAGEABLE_FEATURES);

import { syncUserContainer } from '../provisioning/manager.js';

export interface EntitlementsRouterDeps {
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

      if (changed) {
        await dao.entitlements.bumpTokenVersion(userId);
      }
      if (kind === 'enable' && deps.onEnable) {
        try {
          await deps.onEnable(userId, feature);
        } catch (err) {
          console.error(`[entitlements] onEnable hook failed for ${userId}/${feature}:`, err);
        }
      }
      // 把改装后的新 token 整份推进容器并重载 (azure 自滚新 revision / local 写盘+docker restart)。
      // fire-and-forget: azure 分支是 beginUpdateAndWait (10-30s+ 控制面操作), 绝不阻塞 HTTP 响应 (§3.2)。
      // DB 改装已提交, 前端轮询 /api/status 感知容器回归; 失败仅记录 (token 不进哈希, 无 hash 兜底, 靠用户重试)。
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

  router.post('/api/entitlements/:feature/enable', deps.sessionMw, makeHandler('enable'));
  router.post('/api/entitlements/:feature/disable', deps.sessionMw, makeHandler('disable'));

  return router;
};
