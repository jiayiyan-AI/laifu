const required = (key: string): string => {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
};

export const config = {
  port: parseInt(process.env['PORT'] ?? '3000', 10),
  provisioner: (process.env['PROVISIONER'] ?? 'local') as 'local' | 'azure',
  localContainerUrl: process.env['LOCAL_CONTAINER_URL'] ?? 'http://localhost:8080',
  supabase: {
    url: process.env['SUPABASE_URL'] ?? '',
    serviceRoleKey: process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '',
  },
  azure: {
    subscriptionId: process.env['AZURE_SUBSCRIPTION_ID'] ?? '',
    resourceGroup: process.env['AZURE_RESOURCE_GROUP'] ?? '',
    location: process.env['AZURE_LOCATION'] ?? 'eastasia',
    containerAppsEnv: process.env['AZURE_CONTAINER_APPS_ENV'] ?? '',
    storageAccount: process.env['AZURE_STORAGE_ACCOUNT'] ?? '',
    acrLoginServer: process.env['AZURE_ACR_LOGIN_SERVER'] ?? '',
    hermesImageTag: process.env['HERMES_IMAGE_TAG'] ?? 'hermes-base:v1',
  },
};

// 仅在实际启动 server 时校验，单元测试可跳过
export const validateConfig = () => {
  required('SUPABASE_URL');
  required('SUPABASE_SERVICE_ROLE_KEY');
  if (config.provisioner === 'azure') {
    required('AZURE_SUBSCRIPTION_ID');
    required('AZURE_RESOURCE_GROUP');
  }
};
