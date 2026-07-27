import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Router, type Request, type Response, type Router as RouterType } from 'express';
import type { RuntimeConfig, RuntimeFilesManifest } from '@lingxi/shared';
import { makeContainerTokenMiddleware } from '../auth/container-token.js';
import { config } from '../config.js';
import { dao } from '../db/index.js';
import { piModelProfiles } from '../lib/pi-model-profiles.js';

const PI_MODEL_PROFILES_FILE = 'pi-model-profiles.json';
const SYSTEM_PROMPT_FILE = 'system-prompt.md';
const PROMPTS_DIR = process.env.PROMPTS_DIR ?? join(process.cwd(), 'prompts');

function systemPromptContent(): string | undefined {
  try {
    return readFileSync(join(PROMPTS_DIR, SYSTEM_PROMPT_FILE), 'utf8');
  } catch {
    return undefined;
  }
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

type DynamicFile = { content: string; hash: string };

let cache: Record<string, DynamicFile> | null = null;

function read(): Record<string, DynamicFile> {
  if (cache) return cache;

  const files: Record<string, DynamicFile> = {};
  const systemPrompt = systemPromptContent();
  if (systemPrompt) {
    files[SYSTEM_PROMPT_FILE] = {
      content: systemPrompt,
      hash: contentHash(systemPrompt),
    };
  }
  const profiles_str = JSON.stringify(piModelProfiles);
  files[PI_MODEL_PROFILES_FILE] = {
    content: profiles_str,
    hash: contentHash(profiles_str),
  };
  return cache = files;
}

/** GET /api/me/runtime-config — 容器启动时拉取动态文件清单。 */
export const buildMeRuntimeConfigRouter = (): RouterType => {
  const router = Router();
  const containerAuth = makeContainerTokenMiddleware({
    secret: config.auth.gatewaySecret,
    tokenVersionFetcher: (userId) => dao.entitlements.getTokenVersion(userId),
  });

  router.get('/api/me/runtime-config', containerAuth, (_req: Request, res: Response) => {
    const data = read();
    const files_manifest: RuntimeFilesManifest = {};
    for (const k in  read()) {
      files_manifest[k] = data[k]!.hash;
    }
    const body: RuntimeConfig = { files_manifest };
    res.json(body);
  });

  router.get('/api/me/runtime-config/files/:name', containerAuth, (req: Request, res: Response) => {
    const target = read()[req.params['name'] ?? ''];
    if (!target) {
      res.status(404).json({ error: 'dynamic file not found' });
      return;
    }
    res.type('application/octet-stream').send(target.content);
  });

  return router;
};
