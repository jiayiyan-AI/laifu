import { DefaultAzureCredential } from '@azure/identity';
import { ContainerAppsAPIClient } from '@azure/arm-appcontainers';
import { StorageManagementClient } from '@azure/arm-storage';
import { config } from '../config.js';
import { signLaifuUserToken } from '../lib/gateway-token.js';

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

// Container App 命名必须 ≤ 32 char, 所以 purchase 路由用 user_id 前 8 位 hex 而非完整 uuid;
// 这里的下游函数必须 mirror 同样的命名算法。Source of truth: apps/gateway/src/api/purchase.ts shortHash。
const appNameFor = (userId: string): string => `hermes-${userId.replace(/-/g, '').slice(0, 8)}`;

/**
 * 拿 Storage Account 的访问 key,用于注册 env storage binding。
 * 仅 SMB 模式需要; NFS binding 完全靠 VNet ACL 鉴权, 不需要 key。
 * 当前 NFS 路径不再调本函数, 保留是为了将来万一要回 SMB 时不用重写。
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
 * 共享 NFS share / binding 的固定名称。所有用户的 home 数据都在这一个 share 的子目录里,
 * 通过 ACA volumeMount.subPath 做隔离。这样总存储成本固定 ~$16/月 (100 GiB × $0.16),
 * 不随用户数线性增长 (vs 每用户一个 share = 每用户 $16/月)。详见 docs/nfs.md §十。
 */
const SHARED_SHARE_NAME = 'hermes-shared';
const SHARED_BINDING_NAME = 'hermes-shared-binding';

/**
 * 确保共享 NFS share 存在 (幂等)。所有用户共用这一个 share, 用 subPath 隔离。
 * - enabledProtocols=NFS: 走 NFS 4.1 (POSIX advisory lock 工作正常, 解 SMB 上 SQLite 锁失败问题, 见 known-issues#6)
 * - rootSquash=NoRootSquash: 不重映射 UID, 容器内 hermes 用户 (UID=1000) 能直接写
 * - shareQuota=100: Premium FileStorage v1 share 最小 100 GiB (account 级总配额另算)
 *
 * 用户子目录 (subPath 指向的) 不需要在这里预创建 — ACA volumeMount 挂载时若 subPath 不存在会自动 mkdir。
 *
 * @param _shareName 历史签名遗留参数, 实际不使用, 永远操作 SHARED_SHARE_NAME。保留是为了不动 AzureProvisioner interface。
 */
export const createFileShare = async (_shareName: string): Promise<void> => {
  // fileShares.create 在 share 已存在时返回现有 share, 是幂等的
  await getStorage().fileShares.create(
    config.azure.resourceGroup,
    config.azure.storageAccountNfs,
    SHARED_SHARE_NAME,
    {
      shareQuota: 100,
      enabledProtocols: 'NFS',
      rootSquash: 'NoRootSquash',
    },
  );
};

/**
 * 把共享 NFS share 注册成 Container Apps Environment 级别的 storage binding (幂等)。
 * 所有用户的 container app 都引用同一个 binding, 通过 subPath 区分子目录。
 *
 * Container App 引用 binding (而非直接引用 share) 才能挂载成 volume。
 * NFS binding 不需要 accountKey, 走 VNet subnet ACL 鉴权 (见 docs/nfs.md §4.1)。
 * shareName 必须是 `/<account>/<share>` 双段前导斜杠的 NFS 路径, 不是裸 share 名。
 */
const ensureSharedBinding = async (): Promise<void> => {
  await getContainerApps().managedEnvironmentsStorages.createOrUpdate(
    config.azure.resourceGroup,
    config.azure.containerAppsEnv,
    SHARED_BINDING_NAME,
    {
      properties: {
        nfsAzureFile: {
          server: `${config.azure.storageAccountNfs}.file.core.windows.net`,
          shareName: `/${config.azure.storageAccountNfs}/${SHARED_SHARE_NAME}`,
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
 *   先 createFileShare(shareName)        — 幂等确保共享 share 存在
 *   再 createContainerApp({containerName, shareName})
 *     内部调 ensureSharedBinding() 注册共享 binding (幂等)
 *     然后 volumeMounts.subPath=shareName 让该容器只看到 share 内的 /shareName 子目录
 *
 * shareName 在这里不再是独立 share 的名字, 而是"该用户在共享 share 内的子目录名"
 * (例如 'user-8a599ed4')。subPath 不存在时 ACA 自动 mkdir, 不需要预创建。
 */
export const createContainerApp = async (params: {
  containerName: string;
  shareName: string;
}): Promise<string> => {
  await ensureSharedBinding();

  const { username: acrUser, password: acrPwd } = await getAcrCredentials();
  const envFqdn = `/subscriptions/${config.azure.subscriptionId}/resourceGroups/${config.azure.resourceGroup}/providers/Microsoft.App/managedEnvironments/${config.azure.containerAppsEnv}`;

  // hermes-api-key 走 KV reference: ACA 绑 user-assigned identity, secrets[].keyVaultUrl
  // 让 ACA 控制面自动从 KV 拉, 不再由 gateway 把明文写进 ACA secret。
  // 三个 env 必须齐: identity resourceId / clientId / kvUri。dev local 模式
  // 这些为空, 兜底走 inline secret (保留 hermesApiKey 那一支)。
  const useKvRef = !!(
    config.azure.hermesAcaIdentityResourceId &&
    config.azure.hermesAcaIdentityClientId &&
    config.azure.hermesKvUri
  );
  const hermesApiKeySecret = useKvRef
    ? {
        name: 'hermes-api-key',
        // KV vaultUri 末尾带 '/'; 直接拼 secrets/<name> 即可
        keyVaultUrl: `${config.azure.hermesKvUri.replace(/\/$/, '')}/secrets/hermes-api-key`,
        identity: config.azure.hermesAcaIdentityResourceId,
      }
    : { name: 'hermes-api-key', value: config.azure.hermesApiKey };

  const poller = await getContainerApps().containerApps.beginCreateOrUpdate(
    config.azure.resourceGroup,
    params.containerName,
    {
      location: config.azure.location,
      managedEnvironmentId: envFqdn,
      ...(useKvRef
        ? {
            identity: {
              type: 'UserAssigned',
              userAssignedIdentities: {
                [config.azure.hermesAcaIdentityResourceId]: {},
              },
            },
          }
        : {}),
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
          hermesApiKeySecret,
        ],
      },
      template: {
        // initContainers: 以 root 跑一遍 chown, 修正 ACA 自动创建的 subPath 子目录 owner。
        // 原因: ACA 容器默认带 no_new_privs=true 禁 sudo, hermes image 又 USER hermes,
        //   主容器没办法自己 chown。ACA BaseContainer 没有 securityContext/runAsUser 字段,
        //   不能在 init container 里 override hermes image 的 USER。
        //   所以用 mcr.microsoft.com/cbl-mariner/busybox (微软 Mariner busybox, 默认 root,
        //   公网可拉, 镜像 ~2MB) 跑一行 chown。
        //   ACA 保证 initContainers 全部 exit 0 后才启动主容器。
        initContainers: [
          {
            name: 'init-chown',
            image: 'mcr.microsoft.com/cbl-mariner/busybox:2.0',
            resources: { cpu: 0.25, memory: '0.5Gi' },
            command: ['/bin/sh', '-c'],
            args: ['chown 1000:1000 /home/hermes && chmod 755 /home/hermes'],
            volumeMounts: [{
              volumeName: 'hermes-home',
              mountPath: '/home/hermes',
              subPath: params.shareName,
            }],
          },
        ],
        containers: [
          {
            name: 'hermes',
            image: `${config.azure.acrLoginServer}/${config.azure.hermesImageTag}`,
            resources: { cpu: 1, memory: '2Gi' },
            env: [
              // 创建时一次性快照的 env 只留 2 项 (其余动态配置走 /api/me/runtime-config pull):
              //   - HERMES_API_KEY: ACA secret (KV reference 或 inline value), 容器内做 LLM 鉴权
              //   - GATEWAY_BASE_URL: 容器 entrypoint 拉 runtime-config / entitlements / 续 token 的入口
              // LAIFU_USER_TOKEN 由 signTokenAndInjectAzure 在容器创建后单独写入。
              { name: 'HERMES_API_KEY', secretRef: 'hermes-api-key' },
              { name: 'GATEWAY_BASE_URL', value: config.auth.publicBaseUrl },
            ],
            // subPath: 该用户在共享 share 内的子目录, 容器看不到兄弟用户的目录。
            //   ACA 挂载时若子目录不存在会自动创建, 不需要预 mkdir。
            volumeMounts: [{
              volumeName: 'hermes-home',
              mountPath: '/home/hermes',
              subPath: params.shareName,
            }],
          },
        ],
        volumes: [
          { name: 'hermes-home', storageType: 'NfsAzureFile', storageName: SHARED_BINDING_NAME },
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

/**
 * 给指定用户的 Container App 注入新的 LAIFU_USER_TOKEN。
 * 调用方应已经 bump 过 token_version；本函数只负责 sign + write。
 */
export const signTokenAndInjectAzure = async (
  userId: string,
  tokenVersion: number,
): Promise<void> => {
  const token = signLaifuUserToken({
    userId,
    tokenVersion,
    secret: config.auth.gatewaySecret,
  });
  const appName = appNameFor(userId);
  const current = await getContainerApps().containerApps.get(
    config.azure.resourceGroup, appName,
  );
  const containers = current.template?.containers ?? [];
  if (containers.length === 0) {
    throw new Error(`signTokenAndInjectAzure: no containers in ${appName}`);
  }
  const env = (containers[0]!.env ?? []).filter((e: { name?: string }) => e.name !== 'LAIFU_USER_TOKEN');
  env.push({ name: 'LAIFU_USER_TOKEN', value: token });
  containers[0]!.env = env;
  await getContainerApps().containerApps.beginUpdateAndWait(
    config.azure.resourceGroup, appName,
    { location: current.location, template: { containers } } as any,
  );
};

/**
 * 触发 Container App 重启 (ACA restartRevision)。
 * 拉新 env 起容器,entrypoint 会读 LAIFU_USER_TOKEN + 拉 entitlements + 软链 skill。
 */
export const restartContainerAppAzure = async (userId: string): Promise<void> => {
  const appName = appNameFor(userId);
  const app = await getContainerApps().containerApps.get(
    config.azure.resourceGroup, appName,
  );
  const latestRevisionName = app.latestRevisionName;
  if (!latestRevisionName) {
    throw new Error(`restartContainerAppAzure: no revision for ${appName}`);
  }
  await getContainerApps().containerAppsRevisions.restartRevision(
    config.azure.resourceGroup, appName, latestRevisionName,
  );
};
