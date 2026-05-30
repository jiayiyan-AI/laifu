import type { SupabaseClient } from '@supabase/supabase-js';

export interface AzureStateProbe {
  getContainerAppState(containerName: string): Promise<{ state: string | undefined; fqdn: string | null }>;
}

/**
 * App Service 启动时调用一次：扫表 status=provisioning 的行，
 * 查 Azure 的真实状态，把卡在中间的行推进到 ready/failed。
 */
export const recoverProvisioning = async (
  sb: SupabaseClient,
  azure: AzureStateProbe,
): Promise<void> => {
  const { data, error } = await sb
    .from('container_mapping')
    .select('user_id, container_name')
    .eq('status', 'provisioning');

  if (error) throw new Error(error.message);
  if (!data || data.length === 0) return;

  for (const row of data) {
    try {
      const probe = await azure.getContainerAppState(row.container_name);
      if (probe.state === 'Succeeded' && probe.fqdn) {
        await sb
          .from('container_mapping')
          .update({
            status: 'ready',
            container_url: probe.fqdn,
            ready_at: new Date().toISOString(),
            provisioning_step: '灵犀助理上岗完成',
            progress_pct: 100,
          })
          .eq('user_id', row.user_id);
      } else if (probe.state === 'Failed' || probe.state === 'Canceled') {
        await sb
          .from('container_mapping')
          .update({ status: 'failed', error_message: `Azure state: ${probe.state}` })
          .eq('user_id', row.user_id);
      }
      // else state==='InProgress' / 'Creating' → 暂时不动，下次启动再扫
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await sb
        .from('container_mapping')
        .update({ status: 'failed', error_message: msg })
        .eq('user_id', row.user_id);
    }
  }
};
