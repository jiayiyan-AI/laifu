import { dao } from '../db/index.js';

export interface AzureStateProbe {
  getContainerAppState(containerName: string): Promise<{ state: string | undefined; fqdn: string | null }>;
}

/**
 * App Service 启动时调用一次：扫表 status=provisioning 的行，
 * 查 Azure 的真实状态，把卡在中间的行推进到 ready/failed。
 */
export const recoverProvisioning = async (
  azure: AzureStateProbe,
): Promise<void> => {
  const rows = await dao.containerMapping.listByStatus('provisioning');
  if (rows.length === 0) return;

  for (const row of rows) {
    try {
      const probe = await azure.getContainerAppState(row.container_name);
      if (probe.state === 'Succeeded' && probe.fqdn) {
        await dao.containerMapping.markReady(row.user_id, probe.fqdn, '灵犀助理上岗完成', 100);
      } else if (probe.state === 'Failed' || probe.state === 'Canceled') {
        await dao.containerMapping.markFailed(row.user_id, `Azure state: ${probe.state}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await dao.containerMapping.markFailed(row.user_id, msg);
    }
  }
};
