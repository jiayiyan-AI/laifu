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

export interface ProvisionContainerArgs {
  userId: string;
  containerName: string;
  shareName: string;
  sb: SupabaseClient;
  cache: ContainerMappingCache;
  azure: AzureProvisioner;
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
  const { userId, containerName, shareName, sb, cache, azure } = args;

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
