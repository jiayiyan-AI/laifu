import { dao } from '../db/index.js';
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
  localContainerUrl: string;
  stepDelayMs?: number;
}

export const provisionContainerLocal = async (args: LocalProvisionArgs): Promise<void> => {
  const { userId, localContainerUrl, stepDelayMs = 800 } = args;
  try {
    for (let i = 0; i < STEPS.length - 1; i++) {
      const s = STEPS[i]!;
      await dao.containerMapping.updateStep(userId, s.step, s.pct);
      const data = await dao.containerMapping.getByUserId(userId);
      if (data) dao.cache.set(data);
      if (stepDelayMs > 0) await sleep(stepDelayMs);
    }

    const ready = STEPS[5]!;

    // 本地 dev 容器是 dev-hermes.sh 预起的, 不像 azure 在 create spec 里烤 token,
    // 故这里现签 token 写盘 + docker restart 让 entrypoint 重跑 bootstrap (从源头直接调, 不再注入)。
    const tokenVersion = await dao.users.getTokenVersion(userId) ?? 0;
    try {
      await signTokenAndInjectLocal(userId, tokenVersion);
      await restartContainerAppLocal(userId);
    } catch (err) {
      console.warn(`[local-provisioning] token sign/restart failed for ${userId}:`, err);
    }

    await dao.containerMapping.markReady(userId, localContainerUrl, ready.step, ready.pct);
    const data = await dao.containerMapping.getByUserId(userId);
    if (data) dao.cache.set(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await dao.containerMapping.markFailed(userId, msg);
    dao.cache.delete(userId);
    console.error(`[local-provisioning] failed for ${userId}:`, msg);
  }
};

// Dev mode constants — matching scripts/dev-hermes.sh
const DEV_HOST_VOL = path.join(homedir(), '.hermes-dev');
const DEV_TOKEN_PATH = path.join(DEV_HOST_VOL, '.hermes', '.laifu_user_token');
const DEV_CONTAINER_NAME = 'lingxi-hermes-dev';

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
