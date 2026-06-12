import { dao } from '../db/index.js';

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
  createContainerApp(params: { containerName: string; shareName: string }): Promise<string>;
}

/**
 * 提供给 provisioner 最后一步调用, 负责签发 LAIFU_USER_TOKEN 到容器 +
 * 重启容器让 entrypoint 重跑 bootstrap (pull-runtime-config / entitlements)。
 */
export type SignTokenAndRestart = (userId: string, tokenVersion: number) => Promise<void>;

export interface ProvisionContainerArgs {
  userId: string;
  containerName: string;
  shareName: string;
  azure: AzureProvisioner;
  signTokenAndRestart?: SignTokenAndRestart;
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
  const { userId, containerName, shareName, azure, signTokenAndRestart } = args;

  try {
    await updateStep(userId, STEPS[0].step, STEPS[0].pct);

    await updateStep(userId, STEPS[1].step, STEPS[1].pct);
    await azure.createFileShare(shareName);

    await updateStep(userId, STEPS[2].step, STEPS[2].pct);
    const url = await azure.createContainerApp({ containerName, shareName });

    await updateStep(userId, STEPS[3].step, STEPS[3].pct);
    await updateStep(userId, STEPS[4].step, STEPS[4].pct);

    if (signTokenAndRestart) {
      const tokenVersion = await dao.users.getTokenVersion(userId) ?? 0;
      try {
        await signTokenAndRestart(userId, tokenVersion);
      } catch (err) {
        console.warn(`[provisioning] signTokenAndRestart failed for ${userId}:`, err);
      }
    }

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
