import { dao } from '../db/index.js';
import * as azureModule from './azure.js';
import { shareNameFor } from './naming.js';
import { provisionContainerLocal, signTokenAndInjectLocal, restartContainerAppLocal } from './local.js';
import { config } from '../config.js';
import { getContainerToken } from '../lib/aca-call.js';

// 与 spec §1.1 用户旅程里 6 步进度文案一致
const STEPS = [
  { step: '正在创建账户与订单', pct: 5 },
  { step: '正在生成数字助理实例', pct: 20 },
  { step: '为助理分配 DID 与 Agent 运行时', pct: 40 },
  { step: '初始化默认能力', pct: 70 },
  { step: '装载基础知识库', pct: 90 },
  { step: '灵犀助理上岗完成', pct: 100 },
] as const;

export interface AzureProvisioner {
  createFileShare(shareName: string): Promise<void>;
  createContainerApp(userId: string): Promise<string>;
}

export interface ProvisionContainerArgs {
  userId: string;
  azure: AzureProvisioner;
}

const updateStep = async (
  userId: string,
  step: string,
  pct: number,
): Promise<void> => {
  await dao.containerMapping.updateStep(userId, step, pct);
  const data = await dao.containerMapping.getByUserId(userId);
  if (data) dao.cache.set(data);
};

export const provisionContainer = async (args: ProvisionContainerArgs): Promise<void> => {
  const { userId, azure } = args;

  try {
    await updateStep(userId, STEPS[0].step, STEPS[0].pct);

    await updateStep(userId, STEPS[1].step, STEPS[1].pct);
    await azure.createFileShare(shareNameFor(userId));

    await updateStep(userId, STEPS[2].step, STEPS[2].pct);
    const url = await azure.createContainerApp(userId);
    // create 应用的就是该用户当前 policy 哈希; 写回避免首次 sweep / lazy 误触发一次空 reconcile。
    await dao.containerMapping.setPolicyHash(userId, azureModule.policyHashFor(userId));

    await updateStep(userId, STEPS[3].step, STEPS[3].pct);
    await updateStep(userId, STEPS[4].step, STEPS[4].pct);

    // 最终 ready
    await dao.containerMapping.markReady(userId, url, STEPS[5].step, STEPS[5].pct);
    const data = await dao.containerMapping.getByUserId(userId);
    if (data) dao.cache.set(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await dao.containerMapping.markFailed(userId, msg);
    dao.cache.delete(userId);
    console.error(`[provisioning] failed for user ${userId}:`, msg);
  }
};

/**
 * provisioning 统一入口: 按 config.provisioner 分发到 azure / local 实现。
 * purchase 路由直接调它, 不再从外面注入 provisioner —— 编排归属留在 provisioning 层。
 */
export const provisionUser = (userId: string): Promise<void> =>
  config.provisioner === 'local'
    ? provisionContainerLocal({ userId, localContainerUrl: config.localContainerUrl })
    : provisionContainer({ userId, azure: azureModule });

/**
 * entitlements 改装后把用户容器拉齐到当前 token_version (整份推进 + 重载)。entitlements 路由直接调, 不再注入。
 * azure: reconcileContainerAppAzure —— beginUpdateAndWait 整份 apply 现签新 token, 自滚新 revision = 自带重载,
 *        故无需再单独 restart (旧的 restartContainerAppAzure 已无作用, 一并退役)。
 * local: 现签 token 写盘 + docker restart 让 entrypoint 重读 (dev 容器不像 azure 在 create spec 烤 token)。
 */
export const syncUserContainer = async (userId: string): Promise<void> => {
  if (config.provisioner === 'azure') {
    await azureModule.reconcileContainerAppAzure(userId);
  } else {
    const tokenVersion = (await dao.users.getTokenVersion(userId)) ?? 0;
    await signTokenAndInjectLocal(userId, tokenVersion);
    await restartContainerAppLocal(userId);
  }
};

/** resync 容器调用的超时: 覆盖冷容器 0→1 唤醒最坏 (~冷启动 60-90s+); 超时则靠容器 bootstrap 安全网兜底。 */
const RESYNC_TIMEOUT_MS = 180_000;

/**
 * 装备(enable)轻量 resync (方案 A, 见 plans/2026-06-23-entitlement-live-resync):
 * 推 desired 给容器新端点, 容器建软链后同响应回 observed, 直接落库。不 bump token_version、不滚 revision。
 *  - 容器未 ready: 早退。desired 已在 DB, 待容器 bootstrap 的 sync-entitlements 自然读到并回报 (安全网)。
 *  - 现签当前版本 token (不 bump, 容器 requireBearer 不校 version, 天然收)。
 *  - 落 observed + 把 policy_hash 对齐当前策略 —— 否则下次聊天 checkAndReconcileACA 误判漂移再多滚一次 revision。
 * provisioner 不分支: azure / local 都走容器 HTTP (container_url 由 DB 给)。
 */
export const resyncEntitlements = async (userId: string): Promise<void> => {
  const mapping = await dao.containerMapping.getByUserId(userId);
  if (!mapping || mapping.status !== 'ready' || !mapping.container_url) {
    console.log(`[entitlements] resync skip (container not ready) for ${userId}`);
    return;
  }
  const desired = await dao.entitlements.listActive(userId);
  const tokenVersion = (await dao.users.getTokenVersion(userId)) ?? 0;
  const token = await getContainerToken(userId);

  const resp = await fetch(`${mapping.container_url}/internal/resync-entitlements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ entitlements: desired, token_version: tokenVersion }),
    signal: AbortSignal.timeout(RESYNC_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`resync HTTP ${resp.status}`);

  const data = (await resp.json()) as { observed?: string[]; token_version?: number };
  const observed = Array.isArray(data.observed) ? data.observed : [];
  await dao.observedState.upsert({
    user_id: userId,
    observed_entitlements: observed,
    observed_token_version: typeof data.token_version === 'number' ? data.token_version : tokenVersion,
  });
  await dao.containerMapping.setPolicyHash(userId, azureModule.policyHashFor(userId));
};
