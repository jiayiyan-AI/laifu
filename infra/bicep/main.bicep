@description('Resource name prefix')
param namePrefix string = 'lingxi'

@description('Environment short name')
@allowed(['dev','staging','prod'])
param env string = 'dev'

@description('Azure region')
param location string = 'southeastasia'

@description('App Service SKU. B1 是 Always On 最低档; 流量上来后升 P0v3+')
param appServiceSku string = 'B1'

@description('LLM provider 名. Hermes 一等公民: alibaba / anthropic / openai / deepseek / xai; 自建端点用 custom')
param hermesProvider string = 'alibaba'

@description('LLM 默认模型名. provider=alibaba 时如 qwen3-coder-plus; provider=anthropic 时如 claude-sonnet-4-5-20250929.')
param hermesModel string = 'qwen3-coder-plus'

@description('LLM endpoint base URL. alibaba 填 https://dashscope.aliyuncs.com/compatible-mode/v1; anthropic/openai 留空; custom 必填。')
param hermesBaseUrl string = 'https://dashscope.aliyuncs.com/compatible-mode/v1'

@description('部署执行者的 AAD Object ID (az ad signed-in-user show --query id -o tsv). 留空则跳过, 部署完得手动给自己授 Key Vault Secrets Officer.')
param deployerObjectId string = ''

@description('web 对外基础 URL (OAuth redirect / 前端链接). 留空=用 App Service 默认 *.azurewebsites.net 域名; prod 自定义域填 https://laifu.uncagedai.org')
param webBaseUrl string = ''

@description('邮件域 (助手邮箱 + Resend 出站 + CF 入站 catch-all). 默认 laifu.uncagedai.org; prod 用 mail.laifu.uncagedai.org')
param emailDomain string = 'laifu.uncagedai.org'

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
var hermesIdentityName = 'id-hermes-${env}'

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
  // adminUserEnabled: gateway 已改走 Managed Identity (AcrPull) 拉镜像, 不再用 admin 凭据。
  // 待所有存量 ACA 被 reconcile 到 identity 拉取后 (gateway 部署后 boot sweep 完成), 可改 false 收紧。
  // 在此之前保持 true: 未被 sweep 到又冷启动的旧 spec ACA 仍可能用 admin password 拉。
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

resource emailAttachmentContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'email-attachments'
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

// ─────────── User-assigned managed identity for hermes ACA ───────────
// 每个用户 ACA 在创建时绑这个 identity (gateway 通过 IDs 引用)。
// 用 user-assigned 而不是 system-assigned 的原因: ACA 的 secrets[].keyVaultUrl
// 需要在创建时指定 identity, 而 system-assigned 的 principalId 要等 ACA 创建完才出来,
// 形成"identity 还没有 → 没法在创建时引用 → 没法授 KV RBAC"的死锁。
// 用 user-assigned 提前在 bicep 里建好 + 授好 RBAC, ACA 创建时直接绑现成 identity。
resource hermesIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: hermesIdentityName
  location: location
}

// 让 hermes identity 能读 KV 里的 secret (主要是 hermes-api-key, ACA 通过
// secrets[].keyVaultUrl 自动拉)。
resource kvHermesRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: kv
  name: guid(kv.id, hermesIdentity.id, 'kv-secrets-user')
  properties: {
    principalId: hermesIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    // Key Vault Secrets User
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
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

// App Service 日志 → Log Analytics (与 ACA 共用同一 workspace `la`)
// 这样 gateway 的 stdout / HTTP 访问日志 / 平台事件都能在 Portal Logs 用 KQL 查;
// gateway 内只要 console.log JSON 单行, KQL 解析 ResultDescription 即可。
resource appServiceDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: appService
  name: 'to-la'
  properties: {
    workspaceId: la.id
    logs: [
      { category: 'AppServiceConsoleLogs', enabled: true }
      { category: 'AppServiceAppLogs', enabled: true }
      { category: 'AppServiceHTTPLogs', enabled: true }
      { category: 'AppServicePlatformLogs', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
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

// 给 hermes user-assigned identity 在 ACR 拉镜像的权限 (AcrPull)。
// 每个用户 ACA 绑这个 identity, registries[].identity 走它直接拉镜像, 不用 admin password secret。
// 注意: principal 必须是 hermesIdentity (ACA 真正的拉取主体), 不是 App Service —— App Service 是
//   NODE 代码部署, 不从 ACR 拉容器。
resource acrRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: acr
  name: guid(acr.id, hermesIdentity.id, 'acr-pull')
  properties: {
    principalId: hermesIdentity.properties.principalId
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
    PROMPTS_DIR: '/home/site/wwwroot/prompts'
    PUBLIC_BASE_URL: empty(webBaseUrl) ? 'https://${appService.properties.defaultHostName}' : webBaseUrl
    FRONTEND_BASE_URL: empty(webBaseUrl) ? 'https://${appService.properties.defaultHostName}' : webBaseUrl

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
    HERMES_PROVIDER: hermesProvider
    HERMES_MODEL: hermesModel
    HERMES_BASE_URL: hermesBaseUrl

    // 用户 ACA 绑这个 user-assigned identity, 让 ACA secrets[].keyVaultUrl 能去 KV 取值。
    // azure.ts createContainerApp 用 resourceId 同时绑 template.identity 和填 secrets[].identity。
    HERMES_ACA_IDENTITY_RESOURCE_ID: hermesIdentity.id
    // KV vault URI (https://<name>.vault.azure.net), 用于拼 secrets[].keyVaultUrl
    HERMES_KV_URI: kv.properties.vaultUri

    SESSION_SECRET: '@Microsoft.KeyVault(VaultName=${kv.name};SecretName=session-secret)'
    GATEWAY_SECRET: '@Microsoft.KeyVault(VaultName=${kv.name};SecretName=gateway-secret)'
    // 数据库直连 (Drizzle + node-postgres)。连接串含密码, 走 KV secret database-url (需手工灘入 KV)。
    // prod 现阶段是 Supabase 真实库直连 (direct/session pooler, 非 :6543 transaction pooler);
    // 长期可能迁 Azure PG, 届时只换 KV 里的连接串, 代码不动。
    // 改 KV reference 后 App Service 不自动重 resolve, 须重启 (known-issues #9)。
    DATABASE_URL: '@Microsoft.KeyVault(VaultName=${kv.name};SecretName=database-url)'
    DATABASE_SSL: 'true'
    DATABASE_POOL_MAX: '10'
    GOOGLE_CLIENT_ID: '@Microsoft.KeyVault(VaultName=${kv.name};SecretName=google-client-id)'
    GOOGLE_CLIENT_SECRET: '@Microsoft.KeyVault(VaultName=${kv.name};SecretName=google-client-secret)'

    // 邮件能力 (子项 B):入站走 CF Email Routing → Worker → /api/email/inbound,出站走 Resend。
    // 邮件域 = emailDomain 参数 (prod=mail.laifu.uncagedai.org), 需在 CF Email Routing + Resend 验过 DKIM+SPF+DMARC。
    // RESEND_API_KEY 真值在 KV(下方 reference);改 key 后需 `az webapp config appsettings set KV_REFRESH_TRIGGER=...` 触发 re-resolve。
    EMAIL_PROVIDER: 'resend'
    EMAIL_DOMAIN: emailDomain
    EMAIL_FROM_DEFAULT_NAME: '灵犀助理'
    // 入站 webhook 共享密钥 (CF Email Worker 与 gateway 共用)。
    INBOUND_WEBHOOK_SECRET: '@Microsoft.KeyVault(VaultName=${kv.name};SecretName=inbound-webhook-secret)'
    RESEND_API_KEY: '@Microsoft.KeyVault(VaultName=${kv.name};SecretName=resend-api-key)'
    EMAIL_ATTACHMENT_CONTAINER: 'email-attachments'
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
