@description('Resource name prefix')
param namePrefix string = 'lingxi'

@description('Environment short name')
@allowed(['dev','staging','prod'])
param env string = 'dev'

@description('Azure region')
param location string = 'southeastasia'

@description('App Service SKU. B1 是 Always On 最低档; 流量上来后升 P0v3+')
param appServiceSku string = 'B1'

@description('Hermes 镜像 tag, gateway 创建用户 Container App 时引用. 必须包含仓库名, 形如 hermes:v1 或 hermes:latest')
param hermesImageTag string = 'hermes:latest'

@description('LLM 默认模型. anthropic/* 走 ANTHROPIC_API_KEY, qwen-* 走 DASHSCOPE_API_KEY. 当前 hermes-config.yaml 锁定 DashScope, 默认用 qwen-plus.')
param hermesModel string = 'qwen-plus'

@description('部署执行者的 AAD Object ID (az ad signed-in-user show --query id -o tsv). 留空则跳过, 部署完得手动给自己授 Key Vault Secrets Officer.')
param deployerObjectId string = ''

// ─────────── 资源命名 ───────────
var rgSuffix = '${namePrefix}-${env}'
var caeName = 'cae-${rgSuffix}'
var acrName = toLower('acr${replace(rgSuffix, '-', '')}')
var storageName = toLower('st${replace(rgSuffix, '-', '')}')
var storageNfsName = toLower('stnfs${replace(rgSuffix, '-', '')}')
var vnetName = 'vnet-${rgSuffix}'
var caeSubnetName = 'cae-subnet'
var appServicePlanName = 'asp-${rgSuffix}'
var appServiceName = 'app-${rgSuffix}-gateway'
var laName = 'la-${rgSuffix}'
var kvName = toLower('kv-${rgSuffix}')

// ─────────── 基础设施 ───────────
resource la 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: laName
  location: location
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30 }
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: true }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  // isHnsEnabled=true: 启用 ADLS Gen2 命名空间, 让云盘 (apps/gateway cloud router) 可以签
  // directory-scoped SAS (sr=d + sdd) 做多租户隔离。HNS 是创建时一次性 flag, 改不了。
  // 同 account 仍然可以开 File Share 给每用户 Hermes 用 (Azure 支持 HNS account 同时跑 File Share)。
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    isHnsEnabled: true
    minimumTlsVersion: 'TLS1_2'
  }
}

// 云盘 blob container (apps/gateway/src/api/cloud.ts 默认读 'laifu-cloud')
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource cloudContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'laifu-cloud'
  properties: { publicAccess: 'None' }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

// ─────────── VNet (CAE 挂 NFS 的硬前提, 见 docs/nfs.md) ───────────
// CAE 必须创建时绑 VNet, 事后加不了。subnet 必须 /23 或更大, 必须 delegate 给 ACA,
// 必须开 Microsoft.Storage Service Endpoint (NFS share 走 VNet ACL 而非 account key)。
resource vnet 'Microsoft.Network/virtualNetworks@2024-01-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.20.0.0/16'] }
    subnets: [
      {
        name: caeSubnetName
        properties: {
          addressPrefix: '10.20.0.0/23'
          delegations: [
            { name: 'aca', properties: { serviceName: 'Microsoft.App/environments' } }
          ]
          serviceEndpoints: [
            { service: 'Microsoft.Storage' }
          ]
        }
      }
    ]
  }
}

// 子资源引用 (Bicep 推荐做法, 避免在多处 vnet.properties.subnets[0].id 拼)
resource caeSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-01-01' existing = {
  parent: vnet
  name: caeSubnetName
}

// ─────────── Premium FileStorage (NFS, hermes home) ───────────
// 独立 account, 与上面 StorageV2 (云盘) 并存。Premium FileStorage 是单独 kind, 不能合并。
// 关 supportsHttpsTrafficOnly 是 NFS 强制要求 (NFS 不走 TLS)。
// allowSharedKeyAccess=false: NFS 不用 account key, 鉴权完全靠 subnet 白名单。
resource storageNfs 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageNfsName
  location: location
  sku: { name: 'Premium_LRS' }
  kind: 'FileStorage'
  properties: {
    supportsHttpsTrafficOnly: false
    minimumTlsVersion: 'TLS1_2'
    allowSharedKeyAccess: false
    networkAcls: {
      defaultAction: 'Deny'
      virtualNetworkRules: [
        { id: caeSubnet.id, action: 'Allow' }
      ]
      bypass: 'AzureServices'
    }
  }
}

resource nfsFileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storageNfs
  name: 'default'
}

resource cae 'Microsoft.App/managedEnvironments@2024-10-02-preview' = {
  name: caeName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: la.properties.customerId
        sharedKey: la.listKeys().primarySharedKey
      }
    }
    vnetConfiguration: {
      infrastructureSubnetId: caeSubnet.id
      internal: false  // 外部 ingress 仍可达, 用户 hermes-* container 仍按公网 FQDN 暴露
    }
  }
}

// ─────────── Key Vault (敏感配置统一存) ───────────
resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: kvName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
  }
}

// ─────────── App Service (Gateway + Web 同进程) ───────────
resource appServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: appServicePlanName
  location: location
  sku: { name: appServiceSku, tier: appServiceSku == 'B1' ? 'Basic' : 'PremiumV3' }
  kind: 'linux'
  properties: { reserved: true }
}

resource appService 'Microsoft.Web/sites@2023-12-01' = {
  name: appServiceName
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|22-lts'
      alwaysOn: true
      http20Enabled: true
      webSocketsEnabled: true
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      appCommandLine: 'node index.mjs'
    }
  }
}

// 给 App Service system identity 在 KV 读 secret 的权限 (Key Vault Secrets User)
resource kvRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: kv
  name: guid(kv.id, appService.id, 'kv-secrets-user')
  properties: {
    principalId: appService.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
  }
}

// 给部署执行者在 KV 写 secret 的权限 (Key Vault Secrets Officer). 留空则跳过.
resource kvDeployerRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(deployerObjectId)) {
  scope: kv
  name: guid(kv.id, deployerObjectId, 'kv-secrets-officer')
  properties: {
    principalId: deployerObjectId
    principalType: 'User'
    // Key Vault Secrets Officer
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')
  }
}

// 给 App Service 在 Storage Account 写 File Share 的权限 (每用户开通时建一个 share)
resource storageRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, appService.id, 'storage-account-contributor')
  properties: {
    principalId: appService.identity.principalId
    principalType: 'ServicePrincipal'
    // Storage Account Contributor
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '17d1049b-9a84-46fb-8f53-869881c3d3ab')
  }
}

// 同 role 但 scope 是 NFS account, 让 gateway 在 storageNfs 上建 hermes 用户的 NFS share
resource storageNfsRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storageNfs
  name: guid(storageNfs.id, appService.id, 'storage-account-contributor')
  properties: {
    principalId: appService.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '17d1049b-9a84-46fb-8f53-869881c3d3ab')
  }
}

// 给 App Service 在 Container Apps Env 创建 storage binding + 每用户 Container App 的权限
resource caeRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: cae
  name: guid(cae.id, appService.id, 'contributor')
  properties: {
    principalId: appService.identity.principalId
    principalType: 'ServicePrincipal'
    // Contributor
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b24988ac-6180-42a0-ab88-20f7382dd24c')
  }
}

// 给 App Service 在 RG 范围 Contributor: 每用户 Container App 资源创建在 RG 下,
// CAE 范围的 role 不够 (CAE 是 parent reference 而非 scope), 必须 RG 级.
resource rgRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: resourceGroup()
  name: guid(resourceGroup().id, appService.id, 'contributor-rg')
  properties: {
    principalId: appService.identity.principalId
    principalType: 'ServicePrincipal'
    // Contributor
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b24988ac-6180-42a0-ab88-20f7382dd24c')
  }
}

// 给 App Service 在 ACR 拉镜像的权限 (ACA 创建时若走 managed identity 拉镜像需要)
resource acrRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: acr
  name: guid(acr.id, appService.id, 'acr-pull')
  properties: {
    principalId: appService.identity.principalId
    principalType: 'ServicePrincipal'
    // AcrPull
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}

// 给 App Service 在 Storage Blob 上签 User Delegation Key 的权限 (云盘签 SAS 必需)。
// 注意: 上面的 'Storage Account Contributor' 是控制面 (建 File Share), 不能签 UDK;
// 必须额外加 'Storage Blob Data Owner' 数据面 role。
resource storageBlobOwnerRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, appService.id, 'storage-blob-data-owner')
  properties: {
    principalId: appService.identity.principalId
    principalType: 'ServicePrincipal'
    // Storage Blob Data Owner
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b')
  }
}

// App Service app settings (非敏感) + Key Vault references (敏感)
// 敏感值约定: 在 KV 里手工建 secret, 名字必须与下面 SecretName 一致
resource appSettings 'Microsoft.Web/sites/config@2023-12-01' = {
  parent: appService
  name: 'appsettings'
  properties: {
    WEBSITE_NODE_DEFAULT_VERSION: '~22'
    SCM_DO_BUILD_DURING_DEPLOYMENT: 'false'
    NODE_ENV: 'production'

    PORT: '8080'
    WEB_DIST_PATH: '/home/site/wwwroot/web-dist'
    PUBLIC_BASE_URL: 'https://${appService.properties.defaultHostName}'
    FRONTEND_BASE_URL: 'https://${appService.properties.defaultHostName}'

    PROVISIONER: 'azure'
    AZURE_SUBSCRIPTION_ID: subscription().subscriptionId
    AZURE_RESOURCE_GROUP: resourceGroup().name
    AZURE_LOCATION: location
    AZURE_CONTAINER_APPS_ENV: cae.name
    AZURE_STORAGE_ACCOUNT: storage.name
    AZURE_STORAGE_ACCOUNT_NFS: storageNfs.name
    AZURE_STORAGE_CONTAINER: 'laifu-cloud'
    AZURE_STORAGE_BLOB_ENDPOINT: storage.properties.primaryEndpoints.blob
    AZURE_ACR_LOGIN_SERVER: acr.properties.loginServer
    AZURE_ACR_NAME: acr.name
    HERMES_IMAGE_TAG: hermesImageTag
    HERMES_MODEL: hermesModel

    SESSION_SECRET: '@Microsoft.KeyVault(VaultName=${kv.name};SecretName=session-secret)'
    GATEWAY_SECRET: '@Microsoft.KeyVault(VaultName=${kv.name};SecretName=gateway-secret)'
    SUPABASE_URL: '@Microsoft.KeyVault(VaultName=${kv.name};SecretName=supabase-url)'
    SUPABASE_SERVICE_ROLE_KEY: '@Microsoft.KeyVault(VaultName=${kv.name};SecretName=supabase-service-role-key)'
    GOOGLE_CLIENT_ID: '@Microsoft.KeyVault(VaultName=${kv.name};SecretName=google-client-id)'
    GOOGLE_CLIENT_SECRET: '@Microsoft.KeyVault(VaultName=${kv.name};SecretName=google-client-secret)'
    ANTHROPIC_API_KEY: '@Microsoft.KeyVault(VaultName=${kv.name};SecretName=anthropic-api-key)'
    DASHSCOPE_API_KEY: '@Microsoft.KeyVault(VaultName=${kv.name};SecretName=dashscope-api-key)'

    // 邮件能力 (子项 B)。prod 暂留 fake (Postmark 域名/DNS 验证完成前不真收发, 见 spec §八);
    // 域名+DKIM+入站 webhook 就绪后把 EMAIL_PROVIDER 改 'postmark' + 填两个 KV secret 即可。
    EMAIL_PROVIDER: 'fake'
    EMAIL_DOMAIN: 'mail.localhost'
    EMAIL_FROM_DEFAULT_NAME: '灵犀助理'
    POSTMARK_INBOUND_WEBHOOK_SECRET: '@Microsoft.KeyVault(VaultName=${kv.name};SecretName=postmark-inbound-webhook-secret)'
    POSTMARK_SERVER_TOKEN: '@Microsoft.KeyVault(VaultName=${kv.name};SecretName=postmark-server-token)'
  }
}

// ─────────── 输出 ───────────
output acrLoginServer string = acr.properties.loginServer
output acrName string = acr.name
output containerAppsEnvName string = cae.name
output storageAccountName string = storage.name
output storageNfsAccountName string = storageNfs.name
output appServiceHost string = appService.properties.defaultHostName
output appServiceName string = appService.name
output keyVaultName string = kv.name
output resourceGroup string = resourceGroup().name
