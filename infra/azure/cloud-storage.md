# Cloud Drive — Storage Setup Runbook

P0 基建：创建 HNS-enabled storage account + container `laifu-cloud`，给 gateway 用的身份赋
"Storage Blob Data Owner" 角色（签 User Delegation Key 必需）。

## 1. 变量

```bash
export AZ_RG=lingxi-rg                 # 已有 resource group
export AZ_LOC=eastasia                 # 同 ACA 所在 region
export STORAGE_ACCOUNT=laifudev        # prod 用 laifuprod；dev 用 laifudev
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
  --hierarchical-namespace true \
  --enable-hierarchical-namespace true \
  --min-tls-version TLS1_2 \
  --allow-blob-public-access false
```

**关键参数**：`--hierarchical-namespace true` 启用 ADLS Gen2，这是 directory-scoped
SAS (`sr=d` + `sdd`) 的前提。若用扁平 Blob storage，签出的 SAS 会退化成 container
SAS，racwl 权限会覆盖整个 container —— 多租户隔离失效。

## 3. 创建 container

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
AZURE_STORAGE_ACCOUNT=laifudev
AZURE_STORAGE_CONTAINER=laifu-cloud
AZURE_STORAGE_BLOB_ENDPOINT=https://laifudev.blob.core.windows.net
```

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

```bash
az storage account delete --name "$STORAGE_ACCOUNT" --resource-group "$AZ_RG" --yes
```
