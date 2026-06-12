import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { makeContainerTokenMiddleware } from '../auth/container-token.js';
import { dao } from '../db/index.js';
import type { EntitlementsList } from '@lingxi/shared';

export interface MeEntitlementsRouterDeps {
  secret: string;
}

export const buildMeEntitlementsRouter = (deps: MeEntitlementsRouterDeps): RouterType => {
  const router = Router();
  const containerAuth = makeContainerTokenMiddleware({
    secret: deps.secret,
    tokenVersionFetcher: (userId) => dao.entitlements.getTokenVersion(userId),
  });

  router.get('/api/me/entitlements', containerAuth, async (req: Request, res: Response) => {
    const userId = req.user_id!;
    try {
      const features = await dao.entitlements.listActive(userId);
      const tokenVersion = await dao.entitlements.getTokenVersion(userId);
      const body: EntitlementsList = {
        entitlements: features,
        token_version: tokenVersion ?? 0,
      };
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: 'internal', message: String(err) });
    }
  });

  router.post('/api/me/observed-entitlements', containerAuth, async (req: Request, res: Response) => {
    const userId = req.user_id!;
    const body = req.body as { observed?: unknown; token_version?: unknown };
    if (!Array.isArray(body.observed) || typeof body.token_version !== 'number') {
      res.status(400).json({ error: 'observed (string[]) and token_version (number) required' });
      return;
    }
    try {
      await dao.observedState.upsert({
        user_id: userId,
        observed_entitlements: body.observed as string[],
        observed_token_version: body.token_version,
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: 'internal', message: String(err) });
    }
  });

  return router;
};
