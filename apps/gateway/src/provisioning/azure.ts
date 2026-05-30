import { DefaultAzureCredential } from '@azure/identity';
import { ContainerAppsAPIClient } from '@azure/arm-appcontainers';
import { StorageManagementClient } from '@azure/arm-storage';
import { config } from '../config.js';

const credential = new DefaultAzureCredential();

const _containerApps: ContainerAppsAPIClient | null = null;
const _storage: StorageManagementClient | null = null;

const getContainerApps = (): ContainerAppsAPIClient => {
  return (
    _containerApps ?? new ContainerAppsAPIClient(credential, config.azure.subscriptionId)
  );
};

const getStorage = (): StorageManagementClient => {
  return _storage ?? new StorageManagementClient(credential, config.azure.subscriptionId);
};

/**
 * 在共享 Storage Account 下为该用户创建一个独立的 Azure Files share。
 * MVP 阶段所有用户的 share 都在一个 Storage Account 下（≤100 share 上限够用）。
 */
export const createFileShare = async (shareName: string): Promise<void> => {
  const client = getStorage();
  await client.fileShares.create(
    config.azure.resourceGroup,
    config.azure.storageAccount,
    shareName,
    {},
  );
};

/**
 * 创建 Container App 并轮询直到 ready。
 * 返回 FQDN。
 */
export const createContainerApp = async (params: {
  containerName: string;
  shareName: string;
}): Promise<string> => {
  const client = getContainerApps();
  const envFqdn = `/subscriptions/${config.azure.subscriptionId}/resourceGroups/${config.azure.resourceGroup}/providers/Microsoft.App/managedEnvironments/${config.azure.containerAppsEnv}`;
  const poller = await client.containerApps.beginCreateOrUpdate(
    config.azure.resourceGroup,
    params.containerName,
    {
      location: config.azure.location,
      managedEnvironmentId: envFqdn,
      configuration: {
        ingress: {
          external: true,                // Phase 1.2 用外部 ingress；1.5 改 internal
          targetPort: 8080,
          allowInsecure: false,
        },
      },
      template: {
        containers: [
          {
            name: 'hermes',
            image: `${config.azure.acrLoginServer}/${config.azure.hermesImageTag}`,
            resources: { cpu: 1, memory: '2Gi' },
            volumeMounts: [{ volumeName: 'home', mountPath: '/home/hermes' }],
          },
        ],
        volumes: [
          {
            name: 'home',
            storageType: 'AzureFile',
            storageName: params.shareName,
          },
        ],
        scale: { minReplicas: 0, maxReplicas: 1 },
      },
    },
    { updateIntervalInMs: 5000 },
  );
  const result = await poller.pollUntilDone();
  if (!result.configuration?.ingress?.fqdn) {
    throw new Error('ContainerApp created but no fqdn returned');
  }
  return `https://${result.configuration.ingress.fqdn}`;
};

/**
 * 查 Container App 的当前 provisioningState（用于 startup 恢复时续追）。
 */
export const getContainerAppState = async (
  containerName: string,
): Promise<{ state: string | undefined; fqdn: string | null }> => {
  const client = getContainerApps();
  const r = await client.containerApps.get(config.azure.resourceGroup, containerName);
  return {
    state: r.provisioningState,
    fqdn: r.configuration?.ingress?.fqdn ? `https://${r.configuration.ingress.fqdn}` : null,
  };
};
