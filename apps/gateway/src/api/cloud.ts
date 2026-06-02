import { Router, type Router as RouterType, type Request, type Response, type RequestHandler } from 'express';
import { makeContainerTokenMiddleware } from '../auth/container-token.js';
import { buildDirectoryWriteSas } from '../lib/sas-builder.js';
import type { EntitlementsDao } from '../db/entitlements-dao.js';
import type { UserDelegationKeyCache } from '../lib/user-delegation-key-cache.js';
import type { CloudWriteSasResponse } from '@lingxi/shared';
import type { BlobServiceClient } from '@azure/storage-blob';

export interface CloudRouterConfig {
  accountName: string;
  container: string;
  blobEndpoint: string;
  writeSasTtlSeconds: number;
  readSasTtlSeconds: number;
}

export interface CloudRouterDeps {
  secret: string;
  config: CloudRouterConfig;
  entitlements: Pick<EntitlementsDao, 'listActive' | 'getTokenVersion'>;
  udkCache: Pick<UserDelegationKeyCache, 'get'>;
  blobServiceClient: Pick<BlobServiceClient, 'getContainerClient'>;
  sessionMw: RequestHandler;
}

const FEATURE = 'cloud';

export const buildCloudRouter = (deps: CloudRouterDeps): RouterType => {
  const router = Router();
  const containerAuth = makeContainerTokenMiddleware({
    secret: deps.secret,
    tokenVersionFetcher: (uid) => deps.entitlements.getTokenVersion(uid),
  });

  const requireCloudForContainer: RequestHandler = async (req, res, next) => {
    const userId = req.user_id!;
    try {
      const active = await deps.entitlements.listActive(userId);
      if (!active.includes(FEATURE)) {
        res.status(403).json({ error: 'cloud entitlement not active' });
        return;
      }
      next();
    } catch (err) {
      res.status(500).json({ error: 'internal', message: String(err) });
    }
  };

  router.get('/api/cloud/sas', containerAuth, requireCloudForContainer, async (req: Request, res: Response) => {
    const userId = req.user_id!;
    try {
      const udk = await deps.udkCache.get();
      const out = buildDirectoryWriteSas({
        account: deps.config.accountName,
        container: deps.config.container,
        userId,
        udk,
        ttlSeconds: deps.config.writeSasTtlSeconds,
      });
      const body: CloudWriteSasResponse = {
        blob_endpoint: deps.config.blobEndpoint,
        container: deps.config.container,
        prefix: out.prefix,
        sas_token: out.sasToken,
        expires_at: out.expiresAt.toISOString(),
      };
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: 'internal', message: String(err) });
    }
  });

  return router;
};
