// 拉 desired entitlements → 软链 /opt/hermes-skills/<feature> → ~/.hermes/skills/<feature>
// → 上报 observed。
import {
  readdirSync, lstatSync, unlinkSync, symlinkSync, mkdirSync, existsSync, statSync,
} from 'node:fs';
import { log, warn, readToken, httpJson, HOME_DIR } from './lib.ts';

const SKILLS_DIR = `${HOME_DIR}/.hermes/skills`;
const SKILLS_SOURCE = '/opt/hermes-skills';

/**
 * 声明式收敛 skill 软链: 按 desired 在 skillsDir 建/删软链 (target = sourceDir/<feature>),
 * 返回真正建成的 observed (desired 里 target 存在且建链成功的子集)。幂等, 可安全重复调用。
 * 目录参数化是为了单测能喂临时目录, 生产默认 SKILLS_DIR / SKILLS_SOURCE。
 */
export function applyEntitlements(
  desired: string[],
  skillsDir: string = SKILLS_DIR,
  sourceDir: string = SKILLS_SOURCE,
): string[] {
  mkdirSync(skillsDir, { recursive: true });

  // 清掉不在 desired 里的 stale symlink
  for (const name of readdirSync(skillsDir)) {
    const p = `${skillsDir}/${name}`;
    try {
      if (!lstatSync(p).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    if (!desired.includes(name)) {
      log(`removing stale skill: ${name}`);
      try { unlinkSync(p); } catch (e) { warn(`unlink ${name} failed: ${(e as Error).message}`); }
    }
  }

  // 软链 desired (已存在的 symlink 先删再建, 保证 target 是最新的)
  const observed: string[] = [];
  for (const feature of desired) {
    const target = `${sourceDir}/${feature}`;
    const link = `${skillsDir}/${feature}`;
    if (!existsSync(target) || !statSync(target).isDirectory()) {
      warn(`skill ${feature} requested but not installed in image`);
      continue;
    }
    try {
      if (existsSync(link) || lstatSync(link).isSymbolicLink()) {
        try { unlinkSync(link); } catch {}
      }
    } catch {}
    try {
      symlinkSync(target, link);
      log(`linked skill: ${feature}`);
      observed.push(feature);
    } catch (e) {
      warn(`symlink ${feature} failed: ${(e as Error).message}`);
    }
  }
  return observed;
}

interface EntitlementsResponse {
  entitlements?: string[];
  token_version?: number;
}

async function fetchEntitlements(
  gateway: string,
  token: string,
): Promise<EntitlementsResponse | null> {
  for (let i = 1; i <= 7; i++) {
    try {
      const { status, body } = await httpJson({
        method: 'GET',
        url: `${gateway}/api/me/entitlements`,
        headers: { Authorization: `Bearer ${token}` },
        timeoutMs: 5_000,
      });
      if (status >= 200 && status < 300) {
        log(`entitlements fetched on attempt ${i}`);
        return JSON.parse(body) as EntitlementsResponse;
      }
      warn(`entitlements HTTP ${status} (attempt ${i}/7)`);
    } catch (e) {
      warn(`entitlements attempt ${i}/7 failed: ${(e as Error).message}`);
    }
    if (i < 7) await sleep(3_000);
  }
  return null;
}

export async function runSyncEntitlements(): Promise<void> {
  const GATEWAY = process.env['GATEWAY_BASE_URL'] ?? '';
  const token = readToken();
  if (!token) {
    warn('no token — skip entitlement sync');
    return;
  }

  const ent = await fetchEntitlements(GATEWAY, token);
  if (!ent) {
    warn('failed to fetch entitlements — skill sync skipped');
    return;
  }

  const desired = Array.isArray(ent.entitlements) ? ent.entitlements : [];
  const tokenVersion = typeof ent.token_version === 'number' ? ent.token_version : 0;
  log(`desired entitlements: ${desired.join(' ') || '(none)'}`);

  const observed = applyEntitlements(desired);

  // 上报 observed
  const reportBody = { observed, token_version: tokenVersion };
  log(`reporting observed: ${JSON.stringify(reportBody)}`);
  try {
    const { status, body } = await httpJson({
      method: 'POST',
      url: `${GATEWAY}/api/me/observed-entitlements`,
      headers: { Authorization: `Bearer ${token}` },
      body: reportBody,
      timeoutMs: 10_000,
    });
    if (status < 200 || status >= 300) {
      warn(`observed-entitlements HTTP ${status}: ${body.slice(0, 200)}`);
    }
  } catch (e) {
    warn(`observed-entitlements report failed: ${(e as Error).message}`);
  }
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
