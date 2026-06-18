import { dao } from '../db/index.js';
import * as azureModule from './azure.js';
import { shareNameFor } from './naming.js';
import { provisionContainerLocal, signTokenAndInjectLocal, restartContainerAppLocal } from './local.js';
import { config } from '../config.js';

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
