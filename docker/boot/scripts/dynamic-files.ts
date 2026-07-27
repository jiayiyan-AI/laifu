import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HOME_DIR, httpJson, log, readToken, warn } from './lib.ts';

export const DYNAMIC_DIR = join(HOME_DIR, 'dynamic');
export const DYNAMIC_MANIFEST_PATH = 'manifest.json';
export const PI_MODEL_PROFILES_FILE = 'pi-model-profiles.json';
export const SYSTEM_PROMPT_FILE = 'system-prompt.md';
const LEGACY_DYNAMIC_DIR = join(HOME_DIR, 'dynamic_prompts');

export type DynamicFilesManifest = Record<string, string>;

async function writeAtomically(path: string, content: string): Promise<void> {
  const partial = `${path}.partial`;
  try {
    await writeFile(partial, content, 'utf8');
    await rename(partial, path);
  } catch (error) {
    await unlink(partial).catch(() => {});
    throw error;
  }
}

async function download(gateway: string, token: string, file: string): Promise<void> {
  const { status, body } = await httpJson({
    method: 'GET',
    url: `${gateway}/api/me/runtime-config/files/${encodeURIComponent(file)}`,
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: 10_000,
  });
  if (status < 200 || status >= 300) {
    throw new Error(`HTTP ${status}: ${body.slice(0, 200)}`);
  }
  await writeAtomically(join(DYNAMIC_DIR, file), body);
}

let manifest: DynamicFilesManifest | null = null;

async function readManifest(): Promise<DynamicFilesManifest> {
  if (manifest) return manifest;

  const content = await readFile(join(DYNAMIC_DIR, DYNAMIC_MANIFEST_PATH), 'utf8').catch(() => null);
  if (!content) return manifest = {};

  try {
    return manifest = JSON.parse(content) as DynamicFilesManifest;
  } catch {
    return manifest = {};
  }
}

export function readDynamicFile(file: string): string | null {
  try {
    return readFileSync(join(DYNAMIC_DIR, file), 'utf8');
  } catch {
    return null;
  }
}

export async function syncDynamicFiles(input: DynamicFilesManifest | null | undefined): Promise<void> {
  const token = readToken();
  const gateway = process.env.GATEWAY_BASE_URL ?? '';
  if (!input || !token || !gateway) {
    warn('missing dynamic file manifest, token, or gateway; skipping sync');
    return;
  }

  await mkdir(DYNAMIC_DIR, { recursive: true });
  await rm(LEGACY_DYNAMIC_DIR, { recursive: true, force: true })
    .catch((error) => warn(`remove legacy dynamic_prompts failed: ${String(error)}`));
  const local = await readManifest();
  const remaining = new Set(Object.keys(local));
  let dirty = false;

  const downloads = Object.entries(input).map(async ([name, hash]) => {
    remaining.delete(name);
    if (local[name] === hash) return;
    try {
      await download(gateway, token, name);
      local[name] = hash;
      dirty = true;
      log(`downloaded dynamic file: ${name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warn(`download ${name} failed: ${message}`);
    }
  });

  const removals = [...remaining].map(async (name) => {
    try {
      await rm(join(DYNAMIC_DIR, name), { force: true });
      delete local[name];
      dirty = true;
      log(`removed dynamic file: ${name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warn(`remove ${name} failed: ${message}`);
    }
  });

  await Promise.all([...downloads, ...removals]);
  if (dirty) await writeAtomically(join(DYNAMIC_DIR, DYNAMIC_MANIFEST_PATH), JSON.stringify(local, null, 2));
}
