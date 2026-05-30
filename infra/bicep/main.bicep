@description('Resource name prefix')
param namePrefix string = 'lingxi'

@description('Environment short name')
@allowed(['dev','staging','prod'])
param env string = 'dev'

@description('Azure region')
param location string = 'eastasia'

var rgSuffix = '${namePrefix}-${env}'
var caeName = 'cae-${rgSuffix}'
var acrName = toLower('acr${replace(rgSuffix, '-', '')}')
var storageName = toLower('st${replace(rgSuffix, '-', '')}')
var appServicePlanName = 'asp-${rgSuffix}'
var appServiceName = 'app-${rgSuffix}-gateway'
var laName = 'la-${rgSuffix}'

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

resource appServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: appServicePlanName
  location: location
  sku: { name: 'B1', tier: 'Basic' }
  kind: 'linux'
  properties: { reserved: true }
}

resource appService 'Microsoft.Web/sites@2023-12-01' = {
  name: appServiceName
  location: location
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|22-lts'
      alwaysOn: true
    }
  }
}

output acrLoginServer string = acr.properties.loginServer
output containerAppsEnvId string = cae.id
output storageAccountName string = storage.name
output appServiceHost string = appService.properties.defaultHostName
