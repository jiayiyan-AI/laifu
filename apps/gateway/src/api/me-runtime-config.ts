import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { makeContainerTokenMiddleware } from '../auth/container-token.js';
import type { EntitlementsDao } from '../db/entitlements-dao.js';
import type { RuntimeConfig } from '@lingxi/shared';
import { config } from '../config.js';
import type { PromptStore } from '../lib/prompt-store.js';

export interface MeRuntimeConfigRouterDeps {
  secret: string;
  entitlements: EntitlementsDao;
  prompts: PromptStore;
}

/**
 * GET /api/me/runtime-config — 容器启动时拉,渲染 ~/.hermes/config.yaml +
 * 协商 prompts manifest。
 *
 * 数据源:
 *   - provider/model/base_url: gateway 进程内全局 config (config.azure.hermes*)
 *   - prompts_manifest:        启动时扫 apps/gateway/prompts/ 算出, 内存里
 *
 * 后续若要支持"每用户 override", 这里按 userId 查 DB 再 merge 即可,
 * 接口形状不变 → 容器侧脚本不用动。
 */
export const buildMeRuntimeConfigRouter = (deps: MeRuntimeConfigRouterDeps): RouterType => {
  const router = Router();
  const containerAuth = makeContainerTokenMiddleware({
    secret: deps.secret,
    tokenVersionFetcher: (userId) => deps.entitlements.getTokenVersion(userId),
  });

  router.get('/api/me/runtime-config', containerAuth, (_req: Request, res: Response) => {
    const body: RuntimeConfig = {
      provider: config.azure.hermesProvider,
      model: config.azure.hermesModel,
      base_url: config.azure.hermesBaseUrl || null,
      request_timeout_seconds: 120,
      stale_timeout_seconds: 300,
      prompts_manifest: deps.prompts.manifest(),
    };
    res.json(body);
  });

  // GET /api/me/prompts/:name — 单文件内容下载, 容器拿到 manifest 后按需 pull。
  // 不做缓存协商 (ETag/If-None-Match), manifest 已经承担了 sha 比对的角色。
  router.get('/api/me/prompts/:name', containerAuth, (req: Request, res: Response) => {
    const name = req.params['name'] ?? '';
    // 防穿越: 只允许字母数字 . _ -, 杜绝 .. / 等
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      res.status(400).json({ error: 'invalid prompt name' });
      return;
    }
    const content = deps.prompts.getContent(name);
    if (content == null) {
      res.status(404).json({ error: 'prompt not found' });
      return;
    }
    res.type('text/markdown; charset=utf-8').send(content);
  });

  return router;
};
