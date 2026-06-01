# Cloud Drive — Storage Setup Runbook

P0 基建：创建 HNS-enabled storage account + container `laifu-cloud`，给 gateway 用的身份赋
"Storage Blob Data Owner" 角色（签 User Delegation Key 必需）。

> ⚠️ **Do not deploy `infra/bicep/main.bicep` for storage until it gains `isHnsEnabled: true`** —
> the existing Bicep template provisions a flat (non-HNS) storage account, which would
> downgrade the resources this runbook creates and silently break directory-scoped SAS.
> A follow-up ticket will sync Bicep with this runbook.

## 0. 前提

确认本机 Azure CLI 已登录且在正确订阅：

```bash
az version                                    # CLI 版本应 >= 2.50
az login                                      # 如未登录
az account show --query "{name:name,id:id}"   # 确认订阅是预期那个
# 若不是: az account set --subscription <id-or-name>
az group show --name lingxi-rg                # 确认 RG 存在
```

## 1. 变量

```bash
export AZ_RG=lingxi-rg                 # 已有 resource group
export AZ_LOC=eastasia                 # 同 ACA 所在 region
export STORAGE_ACCOUNT=stlingxidev     # prod 用 stlingxiprod；dev 用 stlingxidev（与 .env.example / Bicep 约定一致）
export CONTAINER=laifu-cloud
```

## 2. 创建 HNS-enabled storage account

```bash
az storage account create \
  --name "$STORAGE_ACCOUNT" \
  --resource-group "$AZ_RG" \
  --location "$AZ_LOC" \
  --sku Standard_LRS \
  --kind StorageV2 \
  --enable-hierarchical-namespace true \
  --min-tls-version TLS1_2 \
  --allow-blob-public-access false
```

**关键参数**：`--enable-hierarchical-namespace true` 启用 ADLS Gen2，这是 directory-scoped
SAS (`sr=d` + `sdd`) 的前提。若用扁平 Blob storage，签出的 SAS 会退化成 container
SAS，racwl 权限会覆盖整个 container —— 多租户隔离失效。

## 3. 创建 container

> 如果遇到 AuthorizationFailure 403，先跑下面 §4 的角色赋权，再回来跑这条；或改用
> `--auth-mode key`（需要 storage account key）。

```bash
az storage container create \
  --name "$CONTAINER" \
  --account-name "$STORAGE_ACCOUNT" \
  --auth-mode login
```

## 4. 给 gateway 的身份赋角色

User Delegation Key 必须由有 "Storage Blob Data Owner"（或 Data Contributor）
角色的身份签发。开发期可以用当前 az 登录的用户：

```bash
SUBSCRIPTION_ID=$(az account show --query id -o tsv)
# 需 az CLI >= 2.50 (Microsoft Graph 端点); 旧版返回字段名是 objectId 而不是 id
USER_OBJECT_ID=$(az ad signed-in-user show --query id -o tsv)

az role assignment create \
  --assignee-object-id "$USER_OBJECT_ID" \
  --assignee-principal-type User \
  --role "Storage Blob Data Owner" \
  --scope "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$AZ_RG/providers/Microsoft.Storage/storageAccounts/$STORAGE_ACCOUNT"
```

生产环境用 ACA 容器的 Managed Identity / Service Principal，参数换成
`--assignee-object-id <MI 的 principal id> --assignee-principal-type ServicePrincipal`。

## 5. 记录到 .env.local

```
AZURE_STORAGE_ACCOUNT=stlingxidev
AZURE_STORAGE_CONTAINER=laifu-cloud
AZURE_STORAGE_BLOB_ENDPOINT=https://stlingxidev.blob.core.windows.net
```

> Note: `AZURE_STORAGE_CONTAINER` and `AZURE_STORAGE_BLOB_ENDPOINT` will be wired into
> `apps/gateway/src/config.ts` by P0 Task 3 (next in the implementation plan). Until that
> task is merged, the gateway only reads `AZURE_STORAGE_ACCOUNT`.

## 6. Azurite (本地开发) 兼容性

Azurite 对 HNS / directory-scoped SAS 的支持历史上不完整。本地开发推荐：
- 单元测试：用 mock UDK，断言 SAS 字符串结构（无需真 storage）
- 集成测试：先尝试 Azurite，跑不通则用真 Azure dev account（`laifudev`）
- P0 验收脚本（`scripts/verify-cloud-sas.ts`）必须用真 Azure 跑，确认跨前缀 PUT 真被拒

跑 Azurite：
```bash
docker run -p 10000:10000 mcr.microsoft.com/azure-storage/azurite \
  azurite-blob --blobHost 0.0.0.0 --enableHierarchicalNamespace true
```
（`--enableHierarchicalNamespace` 是较新版才有的 flag，未必所有版本都生效）

## 7. 删除（实验完清理）

> ⚠️ **DESTRUCTIVE** — this permanently deletes the storage account AND all blobs.
> Only run after confirming you're targeting the dev account (`$STORAGE_ACCOUNT` is set correctly).

```bash
az storage account delete --name "$STORAGE_ACCOUNT" --resource-group "$AZ_RG" --yes
```
