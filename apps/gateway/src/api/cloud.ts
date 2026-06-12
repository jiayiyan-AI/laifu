import { Router, type Router as RouterType, type Request, type Response, type RequestHandler } from 'express';
import multer from 'multer';
import { makeContainerTokenMiddleware } from '../auth/container-token.js';
import { buildDirectoryWriteSas, buildReadBlobSas } from '../lib/sas-builder.js';
import { buildContentDisposition } from '../lib/content-disposition.js';
import { dao } from '../db/index.js';
import type { UserDelegationKeyCache } from '../lib/user-delegation-key-cache.js';
import { validateVirtualPath } from '@lingxi/shared';
import type { CloudWriteSasResponse, CloudListResponse, CloudFileItem, CloudFolderItem, CloudUploadResponse } from '@lingxi/shared';
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
  udkCache: Pick<UserDelegationKeyCache, 'get'>;
  blobServiceClient: Pick<BlobServiceClient, 'getContainerClient'>;
  sessionMw: RequestHandler;
}

const FEATURE = 'cloud';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

const uploadMw = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

const uploadSingle: RequestHandler = (req, res, next) => {
  uploadMw.single('file')(req, res, (err: any) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: 'file too large (10MB limit)' });
        return;
      }
      res.status(400).json({ error: String(err?.message ?? err) });
      return;
    }
    next();
  });
};

export const buildCloudRouter = (deps: CloudRouterDeps): RouterType => {
  const router = Router();
  const containerAuth = makeContainerTokenMiddleware({
    secret: deps.secret,
    tokenVersionFetcher: (uid) => dao.entitlements.getTokenVersion(uid),
  });

  const requireCloudForContainer: RequestHandler = async (req, res, next) => {
    const userId = req.user_id!;
    try {
      const active = await dao.entitlements.listActive(userId);
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

    const active = await dao.entitlements.listActive(userId);
    if (!active.includes(FEATURE)) {
      res.status(403).json({ error: 'cloud entitlement not active' });
      return;
    }

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

  router.get('/api/cloud/download', deps.sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;

    const active = await dao.entitlements.listActive(userId);
    if (!active.includes(FEATURE)) {
      res.status(403).json({ error: 'cloud entitlement not active' });
      return;
    }

    const pathParam = req.query['path'] as string | undefined;
    if (!pathParam) {
      res.status(400).json({ error: 'path query parameter required' });
      return;
    }

    const v = validateVirtualPath(pathParam);
    if (!v.ok) {
      res.status(400).json({ error: `invalid path: ${v.error}` });
      return;
    }

    const dispose = (req.query['dispose'] as string) === 'attachment' ? 'attachment' : 'inline';
    const fullPath = `${userId}/${pathParam}`;
    const containerClient = deps.blobServiceClient.getContainerClient(deps.config.container);
    const blobClient = containerClient.getBlobClient(fullPath);

    let props: { contentType?: string; metadata?: Record<string, string> };
    try {
      props = await blobClient.getProperties() as any;
    } catch (err: any) {
      if (err?.statusCode === 404 || /not found/i.test(String(err))) {
        res.status(404).json({ error: 'blob not found' });
        return;
      }
      res.status(502).json({ error: 'blob head failed', message: String(err) });
      return;
    }

    const udk = await deps.udkCache.get();
    let contentDisposition: string | undefined;
    if (dispose === 'attachment') {
      const title = decodeB64Utf8(props.metadata?.['title']) ?? pathParam.split('/').pop() ?? 'download';
      contentDisposition = buildContentDisposition('attachment', title);
    }

    const sas = buildReadBlobSas({
      account: deps.config.accountName,
      container: deps.config.container,
      blobName: fullPath,
      udk,
      ttlSeconds: deps.config.readSasTtlSeconds,
      contentDisposition,
    });

    const encodedPath = fullPath.split('/').map(encodeURIComponent).join('/');
    const url = `${deps.config.blobEndpoint}/${deps.config.container}/${encodedPath}?${sas.sasToken}`;
    res.redirect(302, url);
  });

  router.post('/api/cloud/upload', deps.sessionMw, uploadSingle, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;

    const active = await dao.entitlements.listActive(userId);
    if (!active.includes(FEATURE)) {
      res.status(403).json({ error: 'cloud entitlement not active' });
      return;
    }

    const file = (req as any).file as { buffer: Buffer; mimetype?: string; originalname?: string } | undefined;
    if (!file) {
      res.status(400).json({ error: 'file field required' });
      return;
    }

    const virtualPath = (req.body?.virtual_path as string | undefined)?.trim() ?? '';
    if (!virtualPath) {
      res.status(400).json({ error: 'virtual_path field required' });
      return;
    }
    const v = validateVirtualPath(virtualPath);
    if (!v.ok) {
      res.status(400).json({ error: `invalid virtual_path: ${v.error}` });
      return;
    }

    const title = (req.body?.title as string | undefined)?.trim() || virtualPath.split('/').pop() || virtualPath;
    const contentType = file.mimetype || 'application/octet-stream';
    const fullPath = `${userId}/${virtualPath}`;
    const nowIso = new Date().toISOString();

    try {
      const containerClient = deps.blobServiceClient.getContainerClient(deps.config.container);
      const blockBlob = containerClient.getBlockBlobClient(fullPath);
      await blockBlob.uploadData(file.buffer, {
        blobHTTPHeaders: { blobContentType: contentType },
        metadata: {
          title: encodeB64Utf8(title),
          published_at: nowIso,
          tool_version: '0.1.0',
          source: 'web',
        },
      });
      const body: CloudUploadResponse = {
        ok: true,
        virtual_path: virtualPath,
        size: file.buffer.length,
        last_modified: nowIso,
      };
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: 'blob upload failed', message: String(err) });
    }
  });

  return router;
};

function decodeB64Utf8(s: string | undefined): string | null {
  if (!s) return null;
  try { return Buffer.from(s, 'base64').toString('utf8'); }
  catch { return null; }
}

function encodeB64Utf8(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
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
    source: raw['source'] === 'web' ? 'web' : 'agent',
  };
}
