# 切 NFS: Hermes Volume 从 SMB 迁到 Azure Files NFS 4.1

> 配套: [known-issues.md#6](./known-issues.md) · [architecture.md](./architecture.md) · [deployment.md](./deployment.md)
>
> **状态**: ✅ 已落地 (dev 环境)。
> - 2026-06-03 SMB → NFS 切换完成, SQLite 锁问题根治 (见 §九)
> - 2026-06-03 多租户共享 share + subPath 隔离方案落地, 存储成本从 $16/用户/月 降到 ~$16/总固定 (见 §十)
>
> 本文档既是设计也是执行记录。prod 环境尚未建立, 建时直接按本文 (§五 Step 2 + §十) 走即可。

---

## 一、为什么必须切

`known-issues.md#6` 已实证: SQLite 在 Azure Files SMB 上**任何形式的读写都会失败**(包括单进程、零竞争、新文件), 因为 SQLite 打开数据库时必跑的 `fcntl(F_SETLK)` 在 SMB 上拿不到锁。WAL / EXCLUSIVE / busy_handler 等客户端调参一律无效, CIFS mount 选项 (`nobrl`) ACA/App Service 不让用户改。

更严重的是这个坑**不止 hermes 一家踩**:

- `pip` 用 sqlite 做 HTTP cache (`~/.cache/pip/http-v2/*.sqlite`)
- `npm` cacache (`~/.npm/_cacache/`) 依赖 fcntl 锁
- playwright / chromium 用户数据目录里 `Cookies`、`History`、`Login Data` 全是 sqlite
- Agent 帮用户写小项目时极容易用 `db.sqlite3`
- hermes 上游随时会加新的 sqlite 文件

整盘挂 home 的架构 (`architecture.md` 第三/五章) 前提是 "SMB 能 host 任意文件 IO" — 这个前提塌了。**只要 home 还在 SMB 上, SQLite 雷区就一直在, Agent 任务随时可能因为无关紧要的 cache 写入失败而挂掉, 而我们甚至无法立刻反应过来根因**。

唯一的根治路径是把 share 换成 NFS 4.1, POSIX 锁在 NFS 上工作正常, 所有 SQLite 用户全部救活。其他方案 (把 `state.db` 挪出 SMB、把消息走 PG) 都只是给 hermes 一家打补丁, 不解决 pip/npm/playwright/任意 Agent 项目的潜在崩溃。

---

## 二、真实成本

> ⚠️ **下面是 Provisioned v1 (实际部署的模型) 的数字**。早期文档版本曾错把 v2 单价当成 v1 写, 导致 §二 / §8.3 / architecture.md §7 全部低估 5 倍。已校正。v2 是 2026 推出的**新顶级资源类型** `Microsoft.FileShares`, 不是 `Microsoft.Storage/storageAccounts kind=FileStorage`, 切 v2 需要换 RP + 重写 Bicep, 见 [§十 未来优化](#十-未来优化)。

**Provisioned v1 SSD NFS 实际部署成本** (Southeast Asia 区域):

| 项 | 实际预配 | 单价 | 月成本 |
|------|---------|------|--------|
| Share quota | 100 GiB (Premium FileStorage 最小) | $0.16/GiB/月 | **~$16/月** |
| IOPS / Throughput | 由 share quota 自动派生, 无单独计费 | — | 含在上面 |
| **dev** | | | **~$16/月** |
| **prod (独立 account)** | | | **~$16/月** (建时) |
| **当前总开销** | dev 一份 | | **~$16/月** |

Provisioned v1 计费特性: 按 **share 的 quota 上限**计费, 不按实际占用。所以 1 个 100 GiB share 和 50 个用户各 1 GiB 实际占用、共用一个 100 GiB share, 成本一样。当前 `provisioning/azure.ts:createFileShare` 给每用户单独建一个 100 GiB share → 用户数 × $16/月线性增长。

> **成本警告**: 上面那条意味着 **每加一个用户多 $16/月**。dev 阶段用户量小没问题; 10 个用户就是 $160/月, 100 个用户 $1600/月, 完全不可持续。**100 个用户内必须切到 v2** (v2 是 account 级共享预配, 不按 share 摊), 否则光存储费就 carries 整个项目预算。

**VNet 基础设施费**: CAE 加 VNet 后, 只用 Service Endpoint 不开 Private Endpoint, **不收基础设施费** (architecture.md 警告的 €2/天是 Private Endpoint 才有的, 别混淆)。

---

## 三、平台前置条件 (核实清单)

| 条件 | 必须 | 备注 |
|------|------|------|
| Storage Account 必须是 Premium FileStorage SSD | ✅ | HDD 完全不支持 NFS。与现有 StorageV2 (云盘那个) 并存, 是两个独立 account |
| Storage Account 必须关 `supportsHttpsTrafficOnly` | ✅ | NFS 不走 TLS, 不关会 `mount.nfs: access denied by server` |
| CAE 必须在创建时指定 VNet | ✅ | 一次性参数, 事后加不了 → 必须重建 CAE |
| CAE 用 Consumption-only 还是 workload profile | ❌ 无要求 | Consumption-only 也能挂 NFS volume (之前传言要 workload profile, 误) |
| 用 Service Endpoint 还是 Private Endpoint | Service Endpoint 即可 | Private Endpoint 才有 €2/天费用 |
| 区域 | Southeast Asia / East Asia 都支持 | 当前仓库定调 `southeastasia` (现有 CAE 域名 `nicecoast-546cedcf.southeastasia.azurecontainerapps.io` 也佐证), 别再切 |

---

## 四、本仓库的改动清单

### 4.1 Bicep (`infra/bicep/main.bicep`)

> ⚠️ 以下 API 版本已按 [§8.2](#82-必须修订的章节) POC 验证修订。CAE / managedEnvironments/storages / containerApps 三个资源必须用 `@2024-10-02-preview` 才认 `nfsAzureFile` 与 `NfsAzureFile` 枚举, 旧版直接 400。

**新增资源:**

```bicep
// 1. VNet (CAE 的硬前提)
resource vnet 'Microsoft.Network/virtualNetworks@2024-01-01' = {
  name: 'vnet-${rgSuffix}'
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.20.0.0/16'] }
    subnets: [
      {
        name: 'cae-subnet'
        properties: {
          addressPrefix: '10.20.0.0/23'  // CAE Consumption 要求 /23 或更大
          delegations: [
            { name: 'aca', properties: { serviceName: 'Microsoft.App/environments' } }
          ]
          serviceEndpoints: [
            { service: 'Microsoft.Storage' }  // 让 subnet 能直连 Storage
          ]
        }
      }
    ]
  }
}

// 2. 独立 Premium FileStorage account (NFS 专用, 与现有 StorageV2 并存)
resource storageNfs 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: toLower('stnfs${replace(rgSuffix, '-', '')}')
  location: location
  sku: { name: 'Premium_LRS' }
  kind: 'FileStorage'  // ⚠️ Premium FileStorage 必须是这个 kind
  properties: {
    supportsHttpsTrafficOnly: false  // ⚠️ NFS 关键, 不能为 true (人工核对查 enableHttpsTrafficOnly, 见 §8.2)
    minimumTlsVersion: 'TLS1_2'      // 仍可设, 只影响 SMB/REST, NFS 不受影响
    allowSharedKeyAccess: false      // NFS 用 VNet ACL 认证, 不用 key
    networkAcls: {
      defaultAction: 'Deny'
      virtualNetworkRules: [
        { id: vnet.properties.subnets[0].id, action: 'Allow' }
      ]
      bypass: 'AzureServices'
    }
  }
}

resource nfsFileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storageNfs
  name: 'default'
  properties: {
    protocolSettings: {
      smb: { /* 关掉 SMB, 仅用 NFS */ }
    }
  }
}
```

**改动现有 `cae` 资源 (升 API 版本 + 加 vnetConfiguration):**

```bicep
resource cae 'Microsoft.App/managedEnvironments@2024-10-02-preview' = {  // ⬆️ 必须升, 旧 2024-03-01 不识别 nfsAzureFile
  name: caeName
  location: location
  properties: {
    appLogsConfiguration: { ... }   // 原样
    vnetConfiguration: {            // 新增
      infrastructureSubnetId: vnet.properties.subnets[0].id
      internal: false               // 外部 ingress 仍可达
    }
  }
}
```

**改动现有 role assignments**: `storageRoleAssignment` (Storage Account Contributor) 要新增一份指向 `storageNfs`, 用来在 NFS account 上建 share。原来指向 StorageV2 (云盘) 的那份保留。

### 4.2 业务代码 (`apps/gateway/src/provisioning/azure.ts`)

> ⚠️ 落地前先检查 `@azure/arm-appcontainers` 当前版本: 若 `ManagedEnvironmentStorageProperties` 类型不识别 `nfsAzureFile`, 走 [§8.4](#84-az-cli-vs-rest-工具能力清单) 列的 REST 降级路径 (PUT `?api-version=2024-10-02-preview`)。`fileShares.create` 端 (storage 控制面) 不受影响, SDK 一般已支持 `enabledProtocols`。

改动很小, 集中在 `createFileShare` 和 `createEnvBinding`:

```typescript
// 改一: createFileShare 改用 NFS account, 显式指定 NFS 协议
export const createFileShare = async (shareName: string): Promise<void> => {
  await getStorage().fileShares.create(
    config.azure.resourceGroup,
    config.azure.storageAccountNfs,        // ← 新 env, 指向 Premium FileStorage account
    shareName,
    {
      shareQuota: 100,                     // NFS 最小 100 GiB
      enabledProtocols: 'NFS',             // ← 新字段
      rootSquash: 'NoRootSquash',          // ← 让 hermes 用户能写
    },
  );
};

// 改二: createEnvBinding 不再需要 accountKey (NFS 走 VNet ACL)
const createEnvBinding = async (bindingName: string, shareName: string): Promise<void> => {
  await getContainerApps().managedEnvironmentsStorages.createOrUpdate(
    config.azure.resourceGroup,
    config.azure.containerAppsEnv,
    bindingName,
    {
      properties: {
        nfsAzureFile: {                                          // ← 改用 nfsAzureFile 而非 azureFile
          server: `${config.azure.storageAccountNfs}.file.core.windows.net`,
          shareName: `/${config.azure.storageAccountNfs}/${shareName}`,  // NFS 路径要带 account 前缀
          accessMode: 'ReadWrite',
        },
      },
    },
  );
};

// 容器 volumes 不变, storageType: 'AzureFile' 字段名通用 (binding 区分协议)
```

### 4.3 新 env

按 `environments.md` "新 env 同步出现在三处" 守则:

- `apps/gateway/.env.example`: 加 `AZURE_STORAGE_ACCOUNT_NFS=stnfslingxidev`
- `apps/gateway/src/config.ts`: 加 `azure.storageAccountNfs`
- `infra/bicep/main.bicep` appSettings: 加 `AZURE_STORAGE_ACCOUNT_NFS: storageNfs.name`

### 4.4 Dockerfile / Hermes 镜像

**不需要改动**。挂载点路径 `/home/hermes` 不变, hermes / pip / npm 等程序对挂的是 SMB 还是 NFS 完全无感知。

**唯一要注意**: NFS 4.1 默认会做 UID 映射。当前 hermes 用户 UID=1000 (`useradd -m`), Premium NFS share + `NoRootSquash` 时 UID 1000 在 share 上就是 UID 1000, 写入正常 — **已 POC 验证** (见 §8.1 #3 项)。

### 4.5 已废弃可删除的东西

切 NFS 后, 原 StorageV2 account 上**为 hermes 建的所有 SMB file share** (`user-xxxxxxxx` 这套) 全部作废, 可清掉。云盘那部分 (blob container `laifu-cloud`) 继续用 StorageV2, 不动。

```bash
# dev 环境清理 (谨慎, 生产用户上来后这条命令会删数据)
az storage share-rm list -g rg-lingxi-dev --storage-account stlingxidev \
  --query "[?starts_with(name, 'user-')].name" -o tsv \
  | xargs -I {} az storage share-rm delete -g rg-lingxi-dev \
      --storage-account stlingxidev --name {} --include-deleted
```

---

## 五、落地步骤

> 前提: 平台当前无存量用户, 可整体 destroy-recreate。

### Step 1 — POC 验证 (1-2 小时, 用一次性 RG)

不动现有 dev 环境, 用 `rg-lingxi-nfs-poc` 临时 RG 验证两件事:

```bash
# 1. 建 vnet + premium nfs account + share
RG=rg-lingxi-nfs-poc
az group create -n $RG -l southeastasia
az network vnet create -g $RG -n vnet-poc \
  --address-prefix 10.99.0.0/16 \
  --subnet-name cae-subnet --subnet-prefix 10.99.0.0/23
az network vnet subnet update -g $RG --vnet-name vnet-poc -n cae-subnet \
  --service-endpoints Microsoft.Storage \
  --delegations Microsoft.App/environments

az storage account create -g $RG -n stpocnfs$RANDOM \
  --sku Premium_LRS --kind FileStorage \
  --https-only false \
  --default-action Deny \
  --vnet-name vnet-poc --subnet cae-subnet

# 2. 建 CAE 挂 VNet, 部署一个测试 hermes 容器挂 NFS share, 跑 sqlite probe
# (复用 known-issues.md#6 里 /tmp/p.py 的 probe 脚本)

# 期望结果:
#   === 2.NFS default ===    OK  ← SMB 时这一行是 FAIL, NFS 应该 OK
#   === 3.NFS+WAL ===        OK
#   === 4.NFS+EXCL ===       OK
```

如果 POC 任何一步失败 (典型: mount 拒绝、UID squash、Service Endpoint 没生效), 在这里就要解决, 别带进 dev 环境。

### Step 2 — dev 环境切换 (半天)

```bash
# 1. 清表
# 在 dev DB 上手动 truncate container_mapping (没有真实用户依赖):
#   psql "$DATABASE_URL" -c 'TRUNCATE container_mapping;'

# 2. 销毁现有 dev RG + purge Key Vault
az group delete -n rg-lingxi-dev --yes --no-wait
az keyvault purge -n kv-lingxi-dev

# 3. 用更新后的 Bicep 重新部署
cd infra/bicep && ./deploy.sh dev

# 4. 回灌 KV secret (按 deployment-azure-first-run.md)

# 5. 重 build hermes image 推到新 RG 的 ACR
cd docker/hermes && ACR_NAME=acrlingxidev IMAGE_TAG=v3 ./build-and-push.sh

# 6. 重新部署 gateway
./scripts/build-deploy.sh
cd app-service-deploy && zip -rq ../deploy.zip . -x '*.map' && cd ..
az webapp deploy -g rg-lingxi-dev -n app-lingxi-dev-gateway --src-path deploy.zip --type zip

# 7. 注册 1-2 个测试用户, 走完整流程验证:
#    - 网页注册 → 自动开通 hermes container app (建 NFS share + 绑 binding + 拉容器)
#    - 网页聊一轮 → 容器内 state.db 有数据
#    - 关 tab 重开 → 历史能拉到 (验证 SMB 时的 502 不再出现)
#    - 微信扫码绑定 → iLink polling 正常
#    - 触发云盘开通 → blob container SAS 正常 (云盘走 StorageV2 没动)
```

### Step 3 — prod 切换 (重复 Step 2, 改 env 名)

prod 当前无真实流量, 等同 dev 操作, 没有维护窗口要求。

### Step 4 — 同步文档

切换完后:

- `known-issues.md#6` 标记为已解决 (但保留作为踩坑记录)
- `architecture.md` 第三/五章 "Azure Files SMB 挂载" 改为 "Azure Files NFS 4.1 挂载", 补 VNet 拓扑
- `deployment-azure-first-run.md` 加 NFS share 建立步骤
- `environments.md` 加 `AZURE_STORAGE_ACCOUNT_NFS` env

---

## 六、回滚预案

dev 环境出问题就 destroy 重来一次, 无成本。

prod 上真出问题但已有少量用户的极端场景下: 保留旧 Bicep 在 git 上 (commit `a574267` 之前), 必要时 `git checkout` 旧版重新 deploy, 用户体验回到"SMB + SQLite 锁失败"的已知问题状态。这只是为完整性写, 实操中不会触发, 因为切换在零用户阶段完成。

---

## 七、不在本方案范围内的事

明确**不做**的事, 避免范围蔓延:

- 不动云盘 (StorageV2 + blob container `laifu-cloud`), 它没踩 SQLite 坑
- 不改 hermes 源码, 不动 entrypoint
- 不引入 PG 当消息历史权威源 (那是另一个方案, 等真要做"消息搜索/导出"产品功能时再考虑)
- 不切 region (留在 southeastasia, 与现有 dev/prod 一致)
- 不上 Private Endpoint, 不上 NAT Gateway, 保持网络最简
- **不补 deletion 流程**: 当前 `provisioning/` 只清进程内 cache, 不删 ACA / file share, 删用户后会留孤儿资源。NFS 切换不依赖也不引入这个问题, 留待产品决策清楚 (删除时机 / 数据保留期 / 是否 soft delete) 后单独处理。零用户阶段无实际影响

---

## 八、POC 验证结论 (2026-06-03 执行)

按本文 Step 1 在 `rg-lingxi-nfs-poc` 完整跑过一遍 (RG 已销毁), 七项验证指标**全部通过**, 切换计划成立。

### 8.1 验证矩阵

| # | 验证点 | 结果 | 关键证据 |
|---|--------|------|---------|
| 1 | mount 类型 | ✅ | `stpocnfs21798.file.core.windows.net:/stpocnfs21798/pocshare on /mnt/poc type nfs4 (rw,relatime,vers=4.1,...sec=sys,local_lock=none)` |
| 2 | mount 成功 | ✅ | `ls /mnt/poc` 正常 |
| 3 | UID 不被 squash | ✅ | 容器内 `uid=1000(hermes)`; 写出文件 `stat` 显示 `Uid: 1000 hermes` — `NoRootSquash` 生效 |
| 4 | 普通写入 | ✅ | `echo hi > /mnt/poc/test.txt && cat` 回读正常 |
| 5 | **SQLite default** | ✅ | `OK size=8192 rows=1` (SMB 上同一脚本必 FAIL, 此项是切换可行性的关键证据) |
| 6 | SQLite + WAL | ✅ | `pragma journal_mode=wal -> ('wal',)` + `OK` |
| 7 | SQLite + EXCLUSIVE | ✅ | `pragma locking_mode=EXCLUSIVE -> ('exclusive',)` + `OK` |

`local_lock=none` 表明锁请求走真实 NFS 4.1 服务端, 这正是 `fcntl(F_SETLK)` 在 NFS 上能拿到锁、在 SMB 上拿不到的根本区别。

### 8.2 必须修订的章节

**§4.1 Bicep API 版本**: 本文示例用的 `Microsoft.App/managedEnvironments@2024-03-01` **不够**, 该版本的 storages 子资源不识别 `nfsAzureFile` 属性, REST 调用直接 400 `Unknown properties nfsAzureFile in ManagedEnvironmentStorageView`。**改用 `2024-10-02-preview` 或更新**:

```bicep
resource cae 'Microsoft.App/managedEnvironments@2024-10-02-preview' = { ... }

resource nfsBinding 'Microsoft.App/managedEnvironments/storages@2024-10-02-preview' = {
  parent: cae
  name: 'hermes-nfs'
  properties: {
    nfsAzureFile: {
      server: '${storageNfs.name}.file.core.windows.net'
      shareName: '/${storageNfs.name}/${shareName}'
      accessMode: 'ReadWrite'
    }
  }
}
```

Container App 资源同样要 `@2024-10-02-preview`, 因为 `volumes[].storageType: 'NfsAzureFile'` 是新枚举值, 旧版 schema 不识别。

**§4.1 storage account httpsOnly 字段**: `az storage account show` 输出的 `supportsHttpsTrafficOnly` 是 `null` 不是 bug — 该字段已废弃, 真实值在 `enableHttpsTrafficOnly`。Bicep 里设 `supportsHttpsTrafficOnly: false` 仍生效 (它是 ARM property 名), 但人工核对时要查 `enableHttpsTrafficOnly`。

**§4.2 业务代码注意**: `nfsAzureFile.shareName` 字段值是 `/<account>/<share>` 双段前导斜杠路径, 不是裸 share 名。SDK 类型 (`@azure/arm-appcontainers`) 当前版本可能还没 `nfsAzureFile` 字段, 落地时如果 TS 类型缺, 退到 REST 直调 (见下方 8.4)。

### 8.3 已确认与文档一致的事实

- Premium FileStorage + `httpsOnly=false` + `default-action Deny` + subnet 白名单的组合可用
- CAE `--infrastructure-subnet-resource-id` + subnet `/23` + `Microsoft.App/environments` delegation + `Microsoft.Storage` Service Endpoint 是最小工作集
- NFS share 最小 100 GiB (Provisioned v1 经典模型, az CLI `share-rm create` 走这个), 与 §二、§4.2 一致。**v1 按 quota 计费, 每 share $16/月**, 用户数线性增长。v2 才有 32 GiB 起步, 见 §十
- hermes 镜像 UID=1000 + `NoRootSquash` 直接可写, 不需要镜像改动 (§4.4 假设成立)
- 无 Private Endpoint 时**确实**不收 VNet 基础设施费 (CAE 30 分钟跑下来 RG 总开销 < $0.10)

### 8.4 az CLI vs REST 工具能力清单

落地写 Bicep / TS provisioning 时, 下面这些操作 **CLI 不行只能走 REST**:

| 操作 | CLI 状态 | 落地方式 |
|------|---------|---------|
| 注册 NFS storage binding | `az containerapp env storage set --server ...` 报 `TypeError: object of type 'NoneType' has no len()` (内部硬校验 `account_key`, NFS 没 key) | Bicep `managedEnvironments/storages` 或 REST PUT `?api-version=2024-10-02-preview`, body `properties.nfsAzureFile.{server, shareName, accessMode}` |
| 创建带 NFS volume 的 container app | `az containerapp create` 不认 `NfsAzureFile` storageType | Bicep `containerApps@2024-10-02-preview` 或 REST PUT 整 app |
| 其余 (RG/VNet/subnet/storage account/share-rm/CAE 本体) | ✅ 全部 az CLI OK | 维持 Bicep 即可 |

### 8.5 一个非平台坑要写进 known-issues

`az containerapp exec` 的 ws 通道 + 远端 sh + 本地 sh 三层引号互相吃, inline heredoc / 转义大概率跑不通。验证脚本 (Python/Bash) 要走 stdin: `echo $BASE64 | base64 -d | python3 -`, 完全绕开嵌套。这个技巧建议 append 到 [known-issues.md](./known-issues.md) 作为以后排查的标准手势。

### 8.6 下一步

Bicep 写法已经具备所有信息, 可以进入 §五 Step 2 (dev 环境切换)。建议落地顺序:

1. 改 `infra/bicep/main.bicep`: 升 API 版本 → 加 vnet/subnet → 加 `storageNfs` (FileStorage) → 加 `nfsBinding` 子资源 → 给 CAE 加 `vnetConfiguration`
2. 改 `apps/gateway/src/provisioning/azure.ts`: `createFileShare` 显式 NFS+NoRootSquash, `createEnvBinding` 用 `nfsAzureFile` (类型缺则降级 REST)
3. 同步三处 env (`AZURE_STORAGE_ACCOUNT_NFS`)
4. 销毁 `rg-lingxi-dev` + purge KV → `./deploy.sh dev` → 回灌 secret → 重 build hermes 镜像 → 重发 gateway → 跑 §五 Step 2 的 7 项端到端验证

---

## 九、落地实录 (2026-06-03 dev 环境)

按 §五 Step 2 全流程跑通, 总耗时约 50 分钟。验证: `GET /api/threads/<id>/messages` 返回历史正常 (SMB 时代必 502), 多轮上下文连续。

### 9.1 实际改动文件清单 (5 个)

| 文件 | 改动 |
|------|------|
| `infra/bicep/main.bicep` | +vnet+subnet, +storageNfs (Premium FileStorage), CAE 升 `@2024-10-02-preview`+加 `vnetConfiguration`, +storageNfs role assignment, appSettings 加 `AZURE_STORAGE_ACCOUNT_NFS` |
| `apps/gateway/src/config.ts` | +`azure.storageAccountNfs` 字段 + required 校验; `AZURE_LOCATION` 默认值 `eastasia` → `southeastasia` (修正与实际部署的不一致) |
| `apps/gateway/.env.example` | +`AZURE_STORAGE_ACCOUNT_NFS`; `AZURE_LOCATION` → `southeastasia` |
| `apps/gateway/src/provisioning/azure.ts` | `createFileShare` 改用 NFS account + `enabledProtocols:'NFS'` + `rootSquash:'NoRootSquash'` + 100GiB quota; `createEnvBinding` 改 `nfsAzureFile` (server / shareName `/<account>/<share>` 双前导斜杠); volume `storageType:'NfsAzureFile'` |
| `docs/architecture.md` + `docs/nfs.md` | region 全部统一到 `southeastasia` |

### 9.2 SDK 与计划的对照

落地前担心要 REST 降级, 实际验证后**不需要**:

- `@azure/arm-appcontainers@2.2.0` 已类型支持 `nfsAzureFile` + `StorageType.NfsAzureFile`
- `@azure/arm-storage@18.6.0` 已类型支持 `enabledProtocols` + `rootSquash`

全程类型化 SDK, 零 REST 直调。§8.4 的 REST 降级路径作为后人 fallback 仍保留。

### 9.3 执行序列

```
12:08  az group delete -n rg-lingxi-dev         (~3 分钟)
12:11  az keyvault purge -n kv-lingxi-dev       (~3 分钟, 比想象慢)
12:14  cd infra/bicep && ./deploy.sh dev        (~9 分钟, RoleAssignmentExists 良性 noise 出现 1 次, deploy.sh 已自动当成功处理)
12:23  回灌 8 个 KV secret                       (秒级)
12:23  并行: az acr build hermes:v3              (~12 分钟, 这是 baseline, 镜像层重, 别期望更快)
12:25  并行: az webapp deploy --src deploy.zip   (第一次失败, 见 9.4)
12:35  build / deploy 全部就位
12:40  端到端验证通过
```

### 9.4 实际踩的坑

**(a) Region 配置三处不一致**: `CLAUDE.md`+`.env.example`+`config.ts` 默认 `eastasia`, 但 `parameters.dev.json`+`deploy.sh`+真实部署域名都是 `southeastasia`。差点按 `eastasia` 重 deploy。已统一到 `southeastasia` (现状真相), 不再分歧。

**(b) `deployment-azure-first-run.md` 隐含的顺序约束**: 先 deploy 代码再灌 KV secret = gateway 启动时 KV reference 全部 `SecretNotFound`, 进程 exit 1, 即使后来灌好 secret + `az webapp restart` 也**不会重新 resolve KV reference** — App Service 这层有自己的 cache 不刷新。详见新增的 [known-issues #9](./known-issues.md#9)。

**(c) `az acr build` 后台跑无中间输出**: 本地看似"卡 10 分钟", 实际通过 `az acr task list-runs` 才能看到真实 `Running` 状态。后续 build 应直接查 task 状态而非盯 stdout。

**(d) Hermes 镜像 build 时间 baseline**: ~12 分钟 (uv + python + node + hermes-agent install + 各 skill 包), 这是正常。下次 deploy 镜像未变可走 `--image hermes:latest` 复用 cache。

### 9.5 已废弃但未清理

旧 dev StorageV2 account `stlingxidev` 上的 `user-*` SMB share 因为整个 RG 已销毁, **不存在了**, 不需要按 §4.5 那段额外清理。该段命令保留是为了将来 prod 切换时, 如果用户量已经积累、旧 SMB share 还在的场景。

### 9.6 prod 切换提示

prod 环境当前不存在 (`az group exists -n rg-lingxi-prod` 返回 false), 建时直接按本文走, 不需要任何 dev → prod 迁移。如果 prod 已经有用户:

1. 警惕**所有用户的对话记忆 / pip 包 / hermes config 都在旧 SMB share 上, 切 NFS 会清零** — 必须 azcopy 整体迁移再切, 或者宣布 outage 窗口
2. KV secret 备份顺序: **先 backup → 再删 → 灌新**, 别像 dev 这次"灌完 secret 才发现 KV reference cache 不刷新"

---

## 十、多租户共享 share + subPath 隔离 (2026-06-03 已落地)

### 背景

切 NFS 后第一版部署是**每用户独立 100 GiB share**, 单价 $16/月, 用户数线性增长 (10 用户 $160, 100 用户 $1600)。这是 Premium FileStorage Provisioned v1 模型的固有约束 (按 share quota 计费, 最小 100 GiB)。

发现该问题后选了**共享 share + subPath 隔离**方案 (而不是切 v2), 因为代码改动量极小、不动基建、不需要重新 POC。

### 方案核心

所有用户共用 **一个** 100 GiB NFS share (`hermes-shared`), 在 share 内每人一个子目录:

```
hermes-shared/                    ← 整个 share 100 GiB, $16/月, 不随用户数增长
├── user-8a599ed4/                ← user 1 的 home
├── user-abc12345/                ← user 2 的 home
└── user-def67890/                ← user 3 的 home
```

每个用户的 container app 通过 ACA `volumeMount.subPath` 字段挂载**自己的子目录**到 `/home/hermes`:

```ts
volumeMounts: [{
  volumeName: 'hermes-home',
  mountPath: '/home/hermes',
  subPath: 'user-8a599ed4',  // 容器只看到这个子目录, 兄弟用户不可见
}]
```

这是 Linux **mount namespace 级别**的隔离, 不是文件权限隔离: 容器内 `ls /` 看不到兄弟用户目录, `..` 也跳不出去, 比 chroot 还彻底。

### 成本对比 (固定 $16/月 vs 用户数 × $16)

| 用户数 | 旧方案 (每人独立 share) | 新方案 (共享 share + subPath) |
|--------|------------------------|-------------------------------|
| 1      | $16                    | $16                           |
| 10     | $160                   | $16                           |
| 100    | $1,600                 | $16-32 (撞顶时升预配)         |
| 500    | $8,000                 | ~$80 (升到 500 GiB)            |

100 用户量级**降本 ~100×**。

### 落地踩的两个 ACA 坑 (重要记录)

**坑 1: subPath 子目录的 owner 是 root, hermes 用户 (UID 1000) 写不进**

ACA 看 `subPath: user-XXX` 不存在时自动 mkdir, 但这个 mkdir 是平台 root 跑的, 子目录 owner=root:root, 0755。主容器以 hermes 用户启动, 第一次 `touch /home/hermes/.initialized` 就 Permission denied → exit 1。

**坑 2: ACA 默认 `no_new_privs=true`, sudo 不能用**

最直觉的修法是 entrypoint 第一行 `sudo chown hermes:hermes /home/hermes` (Dockerfile 已配 sudo NOPASSWD)。但 ACA 容器默认带 `no_new_privs=true` Linux kernel 安全 flag, **禁止任何 setuid 提权, 连 sudo 都不行**:

```
sudo: The "no new privileges" flag is set, which prevents sudo from running as root.
```

这是 ACA 平台硬限制, 用户层改不了。

### 最终方案: initContainer 用 busybox (root) chown

ACA 支持 `template.initContainers` (K8s 标准模式)。init container 跑完 exit 0 后, 主容器才启动。所以:

```
启动序列:
  1. init container (busybox, USER=root) 起来
  2. chown 1000:1000 /home/hermes → exit 0
  3. 主容器 (hermes image, USER=hermes) 起来, owner 已是 hermes, 干净启动
```

关键细节: ACA `BaseContainer` schema **没有 securityContext / runAsUser 字段**, 不能 override image 的 USER。所以 init container 必须用一个**默认 USER 是 root 的 image**。我们用了 `mcr.microsoft.com/cbl-mariner/busybox:2.0` (微软 Mariner busybox, ~2MB, 公网可拉, 默认 root)。

**`createContainerApp` 里的实现** (`apps/gateway/src/provisioning/azure.ts`):

```ts
template: {
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
        subPath: params.shareName,  // 与主容器同 subPath, 这样 chown 的就是用户子目录
      }],
    },
  ],
  containers: [ /* 主 hermes 容器, USER=hermes, 不变 */ ],
  volumes: [
    { name: 'hermes-home', storageType: 'NfsAzureFile', storageName: SHARED_BINDING_NAME },
  ],
},
```

### 改动文件 (落地版本)

| 文件 | 改动 |
|------|------|
| `apps/gateway/src/provisioning/azure.ts` | 加 `SHARED_SHARE_NAME` / `SHARED_BINDING_NAME` 常量; `createFileShare` 改幂等地操作共享 share; `createEnvBinding` 改为 `ensureSharedBinding` (零参, 全局唯一); `createContainerApp` 加 initContainers + 主容器 volumeMount.subPath |
| `docker/hermes/entrypoint.sh` | **删掉** 我之前加的 sudo chown 那段 (实际不能用, 留着误导); 用注释说明 owner 由 initContainer 处理 |

**`AzureProvisioner` interface 签名不变**, manager.ts / purchase.ts / local.ts 全部零改动。`shareName` 字段语义从"独立 share 名"变成"用户子目录名", 字符串值仍然是 `user-<8位hex>`, 完全兼容。

### 副作用与已知 trade-off

1. **失去 share 级 quota 隔离**: 100 GiB 是整 share 总池, 用户 A 灌满 100 GiB → 所有人写不进。当前 dev 单用户 < 200 MB, 100 人内撞顶概率极低。真要兜底就在应用层加每用户 quota 监控 (TODO, 不阻塞)
2. **删用户的数据清理责任在应用层**: 旧方案是 `az storage share-rm delete`, 整 share 删掉, 原子。新方案要做 `rm -rf /hermes-shared/user-XXX/`, gateway 不在 VNet 内挂不上 NFS, 实际清理只能靠"下次某个用户被开通触发的容器内操作"或写个 cron container。TODO, 不阻塞
3. **撞 100 GiB 顶时**: `az storage share-rm update --quota 200 --share-name hermes-shared` 一行命令, 秒生效, 不动 container

### v1 → v2 切换 (附录, 长期更优但当前不做)

**Provisioned v2** 是 2024-2025 推出的新顶级资源类型 `Microsoft.FileShares` (独立 RP):

- account 级共享预配, 起步 32 GiB × $0.10 = ~$3.2/月底价 (vs 当前 v1 100 GiB = $16)
- 存储/IOPS/throughput 三维独立预配, 可精确按需上调
- 100 用户场景下 v2 ~$3-10/月 vs 当前 v1 共享 share 方案 $16-32/月

**省钱倍数有限 (3-5×)**, 远不如"独立 share → 共享 share"那波 100× 来得激进。

**切换工程量大** (Bicep 换 RP + SDK 换 `@azure/arm-fileshares` + 重做 POC + 数据迁移), 当前 ROI 不划算。

**何时再考虑**: 单 share 100 GiB 撞顶且预算敏感时; 或者要上 prod 时一并评估; 或者 ACA 后续推出更友好的 v2 binding 让切换成本骤降。
