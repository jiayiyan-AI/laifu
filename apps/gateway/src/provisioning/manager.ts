import type { SupabaseClient } from '@supabase/supabase-js';
import type { ContainerMappingCache } from '../db/cache.js';
import type { ContainerMapping } from '@lingxi/shared';

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
 *
 * 为什么需要: provisioning 阶段创建的容器只有 HERMES_API_KEY 这一项 secret env;
 * provider/model/base_url 都靠 entrypoint 启动后拉 /api/me/runtime-config 渲染 config.yaml,
 * 而调用该接口需要 LAIFU_USER_TOKEN 鉴权。不签这一下, hermes 会卡在 "No inference
 * provider configured"。以前只在 entitlement enable/disable 才签 — 这是帕子。
 */
export type SignTokenAndRestart = (userId: string, tokenVersion: number) => Promise<void>;

export interface ProvisionContainerArgs {
  userId: string;
  containerName: string;
  shareName: string;
  sb: SupabaseClient;
  cache: ContainerMappingCache;
  azure: AzureProvisioner;
  /** 可选 hook: 提供了就在 mark ready 前签发 LAIFU_USER_TOKEN + 重启容器。
   *  不传则跳过 (兼容旧调用点 / 单元测试)。 */
  signTokenAndRestart?: SignTokenAndRestart;
}

const updateStep = async (
  sb: SupabaseClient,
  userId: string,
  step: string,
  pct: number,
  cache: ContainerMappingCache,
): Promise<void> => {
  await sb.from('container_mapping').update({ provisioning_step: step, progress_pct: pct }).eq('user_id', userId);
  // 同步刷 cache 让 /api/status 看到中间进度
  const { data } = await sb.from('container_mapping').select('*').eq('user_id', userId).single();
  if (data) cache.set(data as ContainerMapping);
};

export const provisionContainer = async (args: ProvisionContainerArgs): Promise<void> => {
  const { userId, containerName, shareName, sb, cache, azure, signTokenAndRestart } = args;

  try {
    await updateStep(sb, userId, STEPS[0].step, STEPS[0].pct, cache);

    await updateStep(sb, userId, STEPS[1].step, STEPS[1].pct, cache);
    await azure.createFileShare(shareName);

    await updateStep(sb, userId, STEPS[2].step, STEPS[2].pct, cache);
    const url = await azure.createContainerApp({ containerName, shareName });

    await updateStep(sb, userId, STEPS[3].step, STEPS[3].pct, cache);
    // MVP: 默认能力靠 Container 启动时自带，Gateway 无需额外触发

    await updateStep(sb, userId, STEPS[4].step, STEPS[4].pct, cache);
    // MVP: 知识库装载靠 Container 启动时自带

    // mark ready 前签 LAIFU_USER_TOKEN 到容器 + 重启, 让 entrypoint 拉 runtime-config 渲染 config.yaml
    // (详见 SignTokenAndRestart 注释)。signTokenAndRestart 未传 → 跳过 (兼容测试)。
    if (signTokenAndRestart) {
      // 新用户 token_version DB 默认 0; 幂等 purchase 也可能重跑, 读当前值
      const { data: u } = await sb.from('users').select('token_version').eq('id', userId).single();
      const tokenVersion = (u as { token_version: number } | null)?.token_version ?? 0;
      try {
        await signTokenAndRestart(userId, tokenVersion);
      } catch (err) {
        // 不阻断 provisioning: token 没签上, 用户下一次 entitlement 动作 会补上, 只 log.warn
        console.warn(`[provisioning] signTokenAndRestart failed for ${userId}:`, err);
      }
    }

    // 最终 ready
    const readyAt = new Date().toISOString();
    await sb
      .from('container_mapping')
      .update({
        status: 'ready',
        container_url: url,
        provisioning_step: STEPS[5].step,
        progress_pct: STEPS[5].pct,
        ready_at: readyAt,
      })
      .eq('user_id', userId);

    // 刷缓存
    const { data } = await sb.from('container_mapping').select('*').eq('user_id', userId).single();
    if (data) cache.set(data as ContainerMapping);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sb
      .from('container_mapping')
      .update({ status: 'failed', error_message: msg })
      .eq('user_id', userId);
    cache.delete(userId);
    console.error(`[provisioning] failed for user ${userId}:`, msg);
  }
};
