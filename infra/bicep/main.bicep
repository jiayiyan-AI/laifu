@description('Resource name prefix')
param namePrefix string = 'lingxi'

@description('Environment short name')
@allowed(['dev','staging','prod'])
param env string = 'dev'

@description('Azure region')
param location string = 'eastasia'

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
  properties: { accessTier: 'Hot', allowBlobPublicAccess: false }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource cae 'Microsoft.App/managedEnvironments@2024-03-01' = {
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
    AZURE_ACR_LOGIN_SERVER: acr.properties.loginServer
    AZURE_ACR_NAME: acr.name
    HERMES_IMAGE_TAG: hermesImageTag
    HERMES_MODEL: hermesModel

    SESSION_SECRET: '@Microsoft.KeyVault(VaultName=${kv.name};SecretName=session-secret)'
    SUPABASE_URL: '@Microsoft.KeyVault(VaultName=${kv.name};SecretName=supabase-url)'
    SUPABASE_SERVICE_ROLE_KEY: '@Microsoft.KeyVault(VaultName=${kv.name};SecretName=supabase-service-role-key)'
    GOOGLE_CLIENT_ID: '@Microsoft.KeyVault(VaultName=${kv.name};SecretName=google-client-id)'
    GOOGLE_CLIENT_SECRET: '@Microsoft.KeyVault(VaultName=${kv.name};SecretName=google-client-secret)'
    ANTHROPIC_API_KEY: '@Microsoft.KeyVault(VaultName=${kv.name};SecretName=anthropic-api-key)'
    DASHSCOPE_API_KEY: '@Microsoft.KeyVault(VaultName=${kv.name};SecretName=dashscope-api-key)'
  }
}

// ─────────── 输出 ───────────
output acrLoginServer string = acr.properties.loginServer
output acrName string = acr.name
output containerAppsEnvName string = cae.name
output storageAccountName string = storage.name
output appServiceHost string = appService.properties.defaultHostName
output appServiceName string = appService.name
output keyVaultName string = kv.name
output resourceGroup string = resourceGroup().name
