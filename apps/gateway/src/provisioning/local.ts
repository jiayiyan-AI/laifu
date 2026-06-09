import type { SupabaseClient } from '@supabase/supabase-js';
import type { ContainerMappingCache } from '../db/cache.js';
import type { ContainerMapping } from '@lingxi/shared';
import { signLaifuUserToken } from '../lib/gateway-token.js';
import { config } from '../config.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { exec as execCb } from 'node:child_process';

const exec = promisify(execCb);

const STEPS = [
  { step: '正在创建账户与订单', pct: 5 },
  { step: '正在生成数字助理实例', pct: 20 },
  { step: '为助理分配 DID 与 Agent 运行时', pct: 40 },
  { step: '初始化默认能力', pct: 70 },
  { step: '装载基础知识库', pct: 90 },
  { step: '灵犀助理上岗完成', pct: 100 },
] as const;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface LocalProvisionArgs {
  userId: string;
  sb: SupabaseClient;
  cache: ContainerMappingCache;
  localContainerUrl: string;
  stepDelayMs?: number;
  /** 跟 manager.ts 同名 hook 语义一致: mark ready 前签 LAIFU_USER_TOKEN + restart hermes
   *  容器。不传则跳。 */
  signTokenAndRestart?: (userId: string, tokenVersion: number) => Promise<void>;
}

export const provisionContainerLocal = async (args: LocalProvisionArgs): Promise<void> => {
  const { userId, sb, cache, localContainerUrl, stepDelayMs = 800, signTokenAndRestart } = args;
  try {
    for (let i = 0; i < STEPS.length - 1; i++) {
      const s = STEPS[i]!;
      await sb.from('container_mapping')
        .update({ provisioning_step: s.step, progress_pct: s.pct })
        .eq('user_id', userId);
      // 同步刷 cache 让 /api/status 看到中间进度（否则 cache 卡在 0% 直到 ready）
      const { data: stepRow } = await sb.from('container_mapping')
        .select('*').eq('user_id', userId).single();
      if (stepRow) cache.set(stepRow as ContainerMapping);
      if (stepDelayMs > 0) await sleep(stepDelayMs);
    }

    const ready = STEPS[5]!;

    // mark ready 前签 LAIFU_USER_TOKEN 到 volume + restart hermes 容器, 让 entrypoint
    // 拉 /api/me/runtime-config 渲染 config.yaml。以前只在 entitlement enable/disable 才签,
    // 导致普通 purchase 后 hermes 报 "No inference provider configured"。
    if (signTokenAndRestart) {
      const { data: u } = await sb.from('users').select('token_version').eq('id', userId).single();
      const tokenVersion = (u as { token_version: number } | null)?.token_version ?? 0;
      try {
        await signTokenAndRestart(userId, tokenVersion);
      } catch (err) {
        console.warn(`[local-provisioning] signTokenAndRestart failed for ${userId}:`, err);
      }
    }

    await sb.from('container_mapping')
      .update({
        status: 'ready',
        container_url: localContainerUrl,
        provisioning_step: ready.step,
        progress_pct: ready.pct,
        ready_at: new Date().toISOString(),
      })
      .eq('user_id', userId);

    const { data } = await sb.from('container_mapping').select('*').eq('user_id', userId).single();
    if (data) cache.set(data as ContainerMapping);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sb.from('container_mapping')
      .update({ status: 'failed', error_message: msg })
      .eq('user_id', userId);
    cache.delete(userId);
    console.error(`[local-provisioning] failed for ${userId}:`, msg);
  }
};

// Dev mode constants — matching scripts/dev-hermes.sh
// HOST_VOL is the bind-mount source on the dev box: ${HOME}/.hermes-dev → /home/hermes
const DEV_HOST_VOL = path.join(homedir(), '.hermes-dev');
const DEV_TOKEN_PATH = path.join(DEV_HOST_VOL, '.hermes', '.laifu_user_token');
const DEV_CONTAINER_NAME = 'lingxi-hermes-dev';

/**
 * Write the new LAIFU_USER_TOKEN to the host volume file. The entrypoint reads
 * this file as a fallback when env doesn't have a token (which happens on
 * `docker restart` since restart reuses the original `docker run` env).
 *
 * In production (Azure), provisioning/azure.ts updates the Container App env
 * directly. This local path is dev-only.
 */
export const signTokenAndInjectLocal = async (
  userId: string,
  tokenVersion: number,
): Promise<void> => {
  const token = signLaifuUserToken({
    userId, tokenVersion, secret: config.auth.gatewaySecret,
  });
  await fs.mkdir(path.dirname(DEV_TOKEN_PATH), { recursive: true });
  await fs.writeFile(DEV_TOKEN_PATH, token, { mode: 0o600 });
  console.log(`[provisioning/local] wrote LAIFU_USER_TOKEN to ${DEV_TOKEN_PATH} (version=${tokenVersion})`);
};

/**
 * Restart the dev hermes container. Reuses the original `docker run` env from
 * dev-hermes.sh (which is fine; the entrypoint will pick up the new token from
 * the host volume file written by signTokenAndInjectLocal).
 *
 * No-op if the container isn't running (warns but doesn't throw — dev may be
 * working on something else and not have hermes up).
 */
export const restartContainerAppLocal = async (_userId: string): Promise<void> => {
  try {
    const { stdout } = await exec(`docker inspect -f "{{.State.Running}}" ${DEV_CONTAINER_NAME}`);
    if (stdout.trim() !== 'true') {
      console.log(`[provisioning/local] ${DEV_CONTAINER_NAME} not running — skipping restart`);
      return;
    }
  } catch {
    console.log(`[provisioning/local] ${DEV_CONTAINER_NAME} not found — skipping restart`);
    return;
  }

  try {
    await exec(`docker restart ${DEV_CONTAINER_NAME}`);
    console.log(`[provisioning/local] restarted ${DEV_CONTAINER_NAME}`);
  } catch (err) {
    console.error(`[provisioning/local] docker restart failed:`, err);
    throw err;
  }
};
