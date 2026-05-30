import { DefaultAzureCredential } from '@azure/identity';
import { ContainerAppsAPIClient } from '@azure/arm-appcontainers';
import { StorageManagementClient } from '@azure/arm-storage';
import { config } from '../config.js';

const credential = new DefaultAzureCredential();
let _containerApps: ContainerAppsAPIClient | null = null;
let _storage: StorageManagementClient | null = null;

const getContainerApps = (): ContainerAppsAPIClient => {
  if (!_containerApps) {
    _containerApps = new ContainerAppsAPIClient(credential, config.azure.subscriptionId);
  }
  return _containerApps;
};

const getStorage = (): StorageManagementClient => {
  if (!_storage) {
    _storage = new StorageManagementClient(credential, config.azure.subscriptionId);
  }
  return _storage;
};

/**
 * 拿 Storage Account 的访问 key,用于注册 env storage binding。
 */
const getStorageKey = async (): Promise<string> => {
  const keys = await getStorage().storageAccounts.listKeys(
    config.azure.resourceGroup,
    config.azure.storageAccount,
  );
  const key = keys.keys?.[0]?.value;
  if (!key) throw new Error('no storage key returned');
  return key;
};

/**
 * 拿 ACR 的 admin 凭据。
 * (Phase 1.5 应改用 Container App 的 Managed Identity + AcrPull RBAC,去掉 admin user)
 */
const getAcrCredentials = async (): Promise<{ username: string; password: string }> => {
  const token = await credential.getToken('https://management.azure.com/.default');
  const url = `https://management.azure.com/subscriptions/${config.azure.subscriptionId}/resourceGroups/${config.azure.resourceGroup}/providers/Microsoft.ContainerRegistry/registries/${config.azure.acrName}/listCredentials?api-version=2023-07-01`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token!.token}` },
  });
  if (!resp.ok) throw new Error(`ACR listCredentials failed: ${resp.status}`);
  const data = (await resp.json()) as { username: string; passwords: { value: string }[] };
  const pwd = data.passwords[0]?.value;
  if (!pwd) throw new Error('ACR credentials missing password');
  return { username: data.username, password: pwd };
};

/**
 * 为该用户在共享 Storage Account 下创建独立的 Azure Files share。
 * MVP 阶段所有用户的 share 都在一个 Storage Account 下 (≤100 share 上限够用)。
 */
export const createFileShare = async (shareName: string): Promise<void> => {
  await getStorage().fileShares.create(
    config.azure.resourceGroup,
    config.azure.storageAccount,
    shareName,
    { shareQuota: 5 },
  );
};

/**
 * 把 file share 注册成 Container Apps Environment 级别的 storage binding。
 * Container App 引用 binding (而非直接引用 share) 才能挂载成 volume。
 */
const createEnvBinding = async (bindingName: string, shareName: string): Promise<void> => {
  const storageKey = await getStorageKey();
  await getContainerApps().managedEnvironmentsStorages.createOrUpdate(
    config.azure.resourceGroup,
    config.azure.containerAppsEnv,
    bindingName,
    {
      properties: {
        azureFile: {
          accountName: config.azure.storageAccount,
          accountKey: storageKey,
          shareName,
          accessMode: 'ReadWrite',
        },
      },
    },
  );
};

/**
 * 创建 Container App。一次到位:ingress + ACR 凭据 + LLM key secret + volume 挂载。
 * 返回 https://<fqdn>。
 *
 * 注意调用顺序:
 *   先 createFileShare(shareName)
 *   再 createContainerApp({containerName, shareName})
 *     内部会先调 createEnvBinding(bindingName, shareName) 注册 binding
 *     然后用 storageName=bindingName 创建 Container App
 */
export const createContainerApp = async (params: {
  containerName: string;
  shareName: string;
}): Promise<string> => {
  const bindingName = `storage-${params.containerName.replace(/^hermes-/, '')}`;
  await createEnvBinding(bindingName, params.shareName);

  const { username: acrUser, password: acrPwd } = await getAcrCredentials();
  const envFqdn = `/subscriptions/${config.azure.subscriptionId}/resourceGroups/${config.azure.resourceGroup}/providers/Microsoft.App/managedEnvironments/${config.azure.containerAppsEnv}`;

  const poller = await getContainerApps().containerApps.beginCreateOrUpdate(
    config.azure.resourceGroup,
    params.containerName,
    {
      location: config.azure.location,
      managedEnvironmentId: envFqdn,
      configuration: {
        ingress: {
          external: true,                    // Phase 1.2/1.3 用外部 ingress
          targetPort: 8080,
          allowInsecure: false,
          transport: 'auto',
        },
        registries: [
          { server: config.azure.acrLoginServer, username: acrUser, passwordSecretRef: 'acr-password' },
        ],
        secrets: [
          { name: 'acr-password', value: acrPwd },
          { name: 'openai-api-key', value: config.azure.openaiApiKey },
        ],
      },
      template: {
        containers: [
          {
            name: 'hermes',
            image: `${config.azure.acrLoginServer}/${config.azure.hermesImageTag}`,
            resources: { cpu: 1, memory: '2Gi' },
            env: [{ name: 'OPENAI_API_KEY', secretRef: 'openai-api-key' }],
            volumeMounts: [{ volumeName: 'hermes-home', mountPath: '/home/hermes' }],
          },
        ],
        volumes: [
          { name: 'hermes-home', storageType: 'AzureFile', storageName: bindingName },
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
 * 查 Container App 的当前 provisioningState (用于 startup 恢复时续追)。
 */
export const getContainerAppState = async (
  containerName: string,
): Promise<{ state: string | undefined; fqdn: string | null }> => {
  const r = await getContainerApps().containerApps.get(config.azure.resourceGroup, containerName);
  return {
    state: r.provisioningState,
    fqdn: r.configuration?.ingress?.fqdn ? `https://${r.configuration.ingress.fqdn}` : null,
  };
};
