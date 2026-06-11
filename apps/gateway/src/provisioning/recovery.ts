import type { ContainerMappingDao } from '../db/container-mapping-dao.js';

export interface AzureStateProbe {
  getContainerAppState(containerName: string): Promise<{ state: string | undefined; fqdn: string | null }>;
}

/**
 * App Service 启动时调用一次：扫表 status=provisioning 的行，
 * 查 Azure 的真实状态，把卡在中间的行推进到 ready/failed。
 */
export const recoverProvisioning = async (
  mappingDao: ContainerMappingDao,
  azure: AzureStateProbe,
): Promise<void> => {
  const rows = await mappingDao.listByStatus('provisioning');
  if (rows.length === 0) return;

  for (const row of rows) {
    try {
      const probe = await azure.getContainerAppState(row.container_name);
      if (probe.state === 'Succeeded' && probe.fqdn) {
        await mappingDao.markReady(row.user_id, probe.fqdn, '灵犀助理上岗完成', 100);
      } else if (probe.state === 'Failed' || probe.state === 'Canceled') {
        await mappingDao.markFailed(row.user_id, `Azure state: ${probe.state}`);
      }
      // else state==='InProgress' / 'Creating' → 暂时不动，下次启动再扫
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await mappingDao.markFailed(row.user_id, msg);
    }
  }
};
