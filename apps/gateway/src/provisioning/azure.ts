import { DefaultAzureCredential } from '@azure/identity';
import { ContainerAppsAPIClient, type ContainerApp } from '@azure/arm-appcontainers';
import { StorageManagementClient } from '@azure/arm-storage';
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { dao } from '../db/index.js';
import { signLaifuUserToken } from '../lib/gateway-token.js';
import { type KvSecretName } from '../kv-secrets.js';
import { containerNameFor, shareNameFor } from './naming.js';

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
 * 拼 ACA secrets[].keyVaultUrl 用的 KV secret 完整 URL。
 * Azure 规范 kv.properties.vaultUri 末尾带 '/', 但容忍手工配置漏掉。
 * 用 KvSecretName 而非 string 入参, 把 secret 名笔误挡在编译期。
 */
const kvSecretUrl = (name: KvSecretName): string =>
  `${config.azure.hermesKvUri.replace(/\/$/, '')}/secrets/${name}`;

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
 * 单一事实源 (dynamic-update-aca.md §四)。buildSpec 是唯一拼 ACA spec 的地方,
 * create / reconcile / 算哈希三处共用 —— 加个 env / 调 resources 只改这一处, 无影子结构。
 *
 * 镜像拉取走 ACA 绑的 user-assigned identity (AcrPull RBAC), 没有 admin password secret,
 * 故不存在凭据 staleness; ACR 不再需要 gateway 走网络拉 listCredentials。
 * 唯一易变字段 token 由调用方传入: apply 时传现签 token, 算哈希时传哨兵空值 (排除)。
 */
export const buildSpec = (userId: string, token: string): ContainerApp => {
  const subPath = shareNameFor(userId);
  const HERMES_API_KEY: KvSecretName = 'hermes-api-key';
  const GATEWAY_SECRET: KvSecretName = 'gateway-secret';
  return {
    location: config.azure.location,
    managedEnvironmentId: `/subscriptions/${config.azure.subscriptionId}/resourceGroups/${config.azure.resourceGroup}/providers/Microsoft.App/managedEnvironments/${config.azure.containerAppsEnv}`,
    identity: {
      type: 'UserAssigned',
      userAssignedIdentities: { [config.azure.hermesAcaIdentityResourceId]: {} },
    },
    configuration: {
      ingress: { external: true, targetPort: 8080, allowInsecure: false, transport: 'auto' },
      registries: [
        // 走 hermes user-assigned identity + AcrPull RBAC 拉镜像 (bicep acrRoleAssignment 授权),
        // 不用 admin password secret。identity = ACA 已绑的 user-assigned identity resourceId。
        { server: config.azure.acrLoginServer, identity: config.azure.hermesAcaIdentityResourceId },
      ],
      // 整份 spec 同时供 beginCreateOrUpdate (PUT) 与 beginUpdateAndWait (PATCH)。
      // hermes-api-key (LLM key) + gateway-secret (LAIFU_USER_TOKEN 签发密钥) 两个 KV reference secret,
      // ACA 控制面凭 identity 自动从 KV 拉。
      secrets: [
        { name: HERMES_API_KEY, keyVaultUrl: kvSecretUrl(HERMES_API_KEY), identity: config.azure.hermesAcaIdentityResourceId },
        { name: GATEWAY_SECRET, keyVaultUrl: kvSecretUrl(GATEWAY_SECRET), identity: config.azure.hermesAcaIdentityResourceId },
      ],
    },
    template: {
      // initContainers: 以 root 跑一遍 chown, 修正 ACA 自动创建的 subPath 子目录 owner。
      // 原因: ACA 容器默认带 no_new_privs=true 禁 sudo, hermes image 又 USER hermes, 主容器没办法自己 chown。
      //   ACA BaseContainer 没有 securityContext/runAsUser, 不能 override hermes image 的 USER。
      //   故用 mcr.microsoft.com/cbl-mariner/busybox (默认 root, 公网可拉, ~2MB) 跑一行 chown。
      //   ACA 保证 initContainers 全部 exit 0 后才启动主容器。
      initContainers: [
        {
          name: 'init-chown',
          image: 'mcr.microsoft.com/cbl-mariner/busybox:2.0',
          resources: { cpu: 0.25, memory: '0.5Gi' },
          command: ['/bin/sh', '-c'],
          args: ['chown 1000:1000 /home/hermes && chmod 755 /home/hermes'],
          volumeMounts: [{ volumeName: 'hermes-home', mountPath: '/home/hermes', subPath }],
        },
      ],
      containers: [
        {
          name: 'hermes',
          image: `${config.azure.acrLoginServer}/${config.azure.hermesImageTag}`,
          resources: { cpu: 1, memory: '2Gi' },
          // 创建时一次性快照的 env (其余动态配置走 /api/me/runtime-config pull):
          //   HERMES_API_KEY: ACA secret (KV reference), 容器内做 LLM 鉴权
          //   GATEWAY_BASE_URL: 容器 entrypoint 拉 runtime-config / entitlements / 续 token 的入口
          //   LAIFU_USER_TOKEN: per-user 现签凭据, 算哈希时为哨兵空值 (排除), apply 时为真 token (reconcile 永不丢)。
          //   GATEWAY_SECRET: gateway-secret (KV reference), 容器侧验签 LAIFU_USER_TOKEN 用;
          env: [
            { name: 'HERMES_API_KEY', secretRef: 'hermes-api-key' },
            { name: 'GATEWAY_BASE_URL', value: config.auth.publicBaseUrl },
            { name: 'LAIFU_USER_TOKEN', value: token },
            { name: 'GATEWAY_SECRET', secretRef: GATEWAY_SECRET },
          ],
          volumeMounts: [{ volumeName: 'hermes-home', mountPath: '/home/hermes', subPath }],
        },
      ],
      volumes: [
        { name: 'hermes-home', storageType: 'NfsAzureFile', storageName: SHARED_BINDING_NAME },
      ],
      scale: { minReplicas: 0, maxReplicas: 1 },
    },
  };
};

/**
 * sorted-keys 递归序列化, 保证同一对象不同 key 顺序得到同一字符串 (哈希稳定, 否则重启即全员 reconcile)。
 */
const canonical = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
};

/**
 * per-user policy 哈希: 用哨兵空 token 造一份 spec 再哈希 → 只反映 policy + per-user 派生字段 (subPath)。
 * 同一进程内策略代码不变, 故 memo 进 Map, 热路径 O(1); 进程重启 (策略代码唯一可能变更的时机) 时
 * Map 随之清空, 不留陈旧哈希。
 *
 * token 不进哈希 (真·易变, 随 token_version 轮转; 进哈希则一轮转就触发全员空 reconcile);
 * 靠哨兵空值在哈希里退化成常量等价排除, 无需手写 exclude 列表。镜像拉取走 identity, 无 ACR 凭据需排除。
 */
const hashCache = new Map<string, string>();
export const policyHashFor = (userId: string): string => {
  let h = hashCache.get(userId);
  if (h === undefined) {
    h = createHash('sha256').update(canonical(buildSpec(userId, ''))).digest('hex');
    hashCache.set(userId, h);
  }
  return h;
};

/** 现签该用户当前 token_version 的 LAIFU_USER_TOKEN (从 DB 读版本)。 */
const signTokenFor = async (userId: string): Promise<string> => {
  const version = (await dao.users.getTokenVersion(userId)) ?? 0;
  return signLaifuUserToken({ userId, tokenVersion: version, secret: config.auth.gatewaySecret });
};

/** 组装该用户的完整 ACA spec (现签 token; 镜像拉取走 identity, 无需拉 ACR 凭据)。create / reconcile 共用。 */
const buildContainerAppSpec = async (userId: string): Promise<ContainerApp> => {
  const token = await signTokenFor(userId);
  return buildSpec(userId, token);
};

/**
 * 创建 Container App。一次到位:ingress + identity 拉镜像 + LLM key KV secret + volume 挂载。返回 https://<fqdn>。
 * 内部调 ensureSharedBinding() 注册共享 binding (幂等), volumeMount.subPath 让该容器只看到自己的子目录。
 * subPath 不存在时 ACA 自动 mkdir, 不需要预创建。
 */
export const createContainerApp = async (userId: string): Promise<string> => {
  await ensureSharedBinding();
  const spec = await buildContainerAppSpec(userId);
  const poller = await getContainerApps().containerApps.beginCreateOrUpdate(
    config.azure.resourceGroup,
    containerNameFor(userId),
    spec,
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
 * 把该用户的 ACA 拉齐到当前声明的 spec (beginUpdateAndWait, PATCH 平滑切 revision)。
 * buildContainerAppSpec 整体替换 template + configuration, 含现签 token, 故 token 永不丢失。
 *
 * 唯一的 update 原语, 两个触发源 (dynamic-update-aca.md §六/§八):
 *   - policy 哈希 diff (镜像 / env / resources 改了) → checkAndReconcileACA / sweep 调。
 *   - token_version bump (entitlements 改装) → entitlements 路由调; 注意 token 不进哈希,
 *     故 bump 不会被哈希 diff 捕获, 必须由改装流程显式调一次。
 */
export const reconcileContainerAppAzure = async (userId: string): Promise<void> => {
  const spec = await buildContainerAppSpec(userId);
  await getContainerApps().containerApps.beginUpdateAndWait(
    config.azure.resourceGroup, containerNameFor(userId), spec,
  );
};
