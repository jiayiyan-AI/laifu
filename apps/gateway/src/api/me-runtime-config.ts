import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { makeContainerTokenMiddleware } from '../auth/container-token.js';
import { dao } from '../db/index.js';
import type { RuntimeConfig } from '@lingxi/shared';
import { config } from '../config.js';
import type { PromptStore } from '../lib/prompt-store.js';

export interface MeRuntimeConfigRouterDeps {
  secret: string;
  prompts: PromptStore;
}

/**
 * GET /api/me/runtime-config — 容器启动时拉,渲染 ~/.hermes/config.yaml +
 * 协商 prompts manifest。
 */
export const buildMeRuntimeConfigRouter = (deps: MeRuntimeConfigRouterDeps): RouterType => {
  const router = Router();
  const containerAuth = makeContainerTokenMiddleware({
    secret: deps.secret,
    tokenVersionFetcher: (userId) => dao.entitlements.getTokenVersion(userId),
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

  router.get('/api/me/prompts/:name', containerAuth, (req: Request, res: Response) => {
    const name = req.params['name'] ?? '';
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
