import type { SupabaseClient } from '@supabase/supabase-js';
import type { ContainerMappingCache } from '../db/cache.js';
import type { ContainerMapping } from '@lingxi/shared';

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
}

export const provisionContainerLocal = async (args: LocalProvisionArgs): Promise<void> => {
  const { userId, sb, cache, localContainerUrl, stepDelayMs = 800 } = args;
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
