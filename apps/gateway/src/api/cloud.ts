import { Router, type Router as RouterType, type Request, type Response, type RequestHandler } from 'express';
import { makeContainerTokenMiddleware } from '../auth/container-token.js';
import { buildDirectoryWriteSas } from '../lib/sas-builder.js';
import type { EntitlementsDao } from '../db/entitlements-dao.js';
import type { UserDelegationKeyCache } from '../lib/user-delegation-key-cache.js';
import { validateVirtualPath } from '@lingxi/shared';
import type { CloudWriteSasResponse, CloudListResponse, CloudFileItem, CloudFolderItem } from '@lingxi/shared';
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

  router.get('/api/cloud/list', deps.sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;

    // entitlement check
    const active = await deps.entitlements.listActive(userId);
    if (!active.includes(FEATURE)) {
      res.status(403).json({ error: 'cloud entitlement not active' });
      return;
    }

    // prefix validation: validateVirtualPath rejects trailing slash, so strip+validate+restore
    const prefixParam = (req.query['prefix'] as string) ?? '';
    if (prefixParam) {
      const trimmed = prefixParam.replace(/\/+$/, '');
      const v = validateVirtualPath(trimmed);
      if (!v.ok) {
        res.status(400).json({ error: `invalid prefix: ${v.error}` });
        return;
      }
    }
    let safePrefix = prefixParam;
    if (safePrefix && !safePrefix.endsWith('/')) safePrefix = safePrefix + '/';

    const fullPrefix = `${userId}/${safePrefix}`;
    const containerClient = deps.blobServiceClient.getContainerClient(deps.config.container);

    const folders: CloudFolderItem[] = [];
    const files: CloudFileItem[] = [];

    try {
      const iter = containerClient.listBlobsByHierarchy('/', { prefix: fullPrefix, includeMetadata: true } as any);
      for await (const item of iter as any) {
        if (item.kind === 'prefix') {
          const fullName = item.name as string;
          const rel = fullName.slice(`${userId}/`.length);
          folders.push({ virtual_path: rel });
        } else {
          const blobName = item.name as string;
          const rel = blobName.slice(`${userId}/`.length);
          const props = item.properties ?? {};
          const meta = item.metadata ?? {};

          files.push({
            virtual_path: rel,
            size: props.contentLength ?? 0,
            last_modified: (props.lastModified instanceof Date
              ? props.lastModified
              : new Date(props.lastModified ?? Date.now())).toISOString(),
            content_type: props.contentType ?? null,
            metadata: decodeBlobMetadata(meta, rel),
          });
        }
      }
      const body: CloudListResponse = { folders, files };
      res.json(body);
    } catch (err) {
      res.status(502).json({ error: 'blob list failed', message: String(err) });
    }
  });

  return router;
};

function decodeB64Utf8(s: string | undefined): string | null {
  if (!s) return null;
  try { return Buffer.from(s, 'base64').toString('utf8'); }
  catch { return null; }
}

function decodeBlobMetadata(raw: Record<string, string>, fallbackRelPath: string): CloudFileItem['metadata'] {
  const tagsRaw = decodeB64Utf8(raw['tags']);
  return {
    title: decodeB64Utf8(raw['title']) ?? fallbackRelPath.split('/').pop() ?? fallbackRelPath,
    session_id: raw['session_id'] ?? null,
    published_at: raw['published_at'] ?? null,
    tool_version: raw['tool_version'] ?? null,
    description: decodeB64Utf8(raw['description']),
    tags: tagsRaw ? tagsRaw.split(',').map(s => s.trim()).filter(Boolean) : null,
  };
}
