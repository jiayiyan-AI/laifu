const required = (key: string): string => {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
};

export const config = {
  port: parseInt(process.env['PORT'] ?? '3000', 10),
  provisioner: (process.env['PROVISIONER'] ?? 'local') as 'local' | 'azure',
  localContainerUrl: process.env['LOCAL_CONTAINER_URL'] ?? 'http://localhost:8080',
  session: {
    secret: process.env['SESSION_SECRET'] ?? 'dev-only-insecure-secret',
    cookieName: process.env['SESSION_COOKIE_NAME'] ?? 'lingxi_sid',
    ttlHours: parseInt(process.env['SESSION_TTL_HOURS'] ?? '168', 10),
  },
  auth: {
    mode: (process.env['AUTH_MODE'] ?? 'dev') as 'dev' | 'wechat',
    wechat: {
      appId: process.env['WECHAT_APPID'] ?? '',
      secret: process.env['WECHAT_SECRET'] ?? '',
      redirectUri: process.env['WECHAT_REDIRECT_URI'] ?? '',
    },
  },
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
    acrName: process.env['AZURE_ACR_NAME'] ?? '',           // 用来拿 listCredentials
    hermesImageTag: process.env['HERMES_IMAGE_TAG'] ?? 'hermes:v1',
    openaiApiKey: process.env['OPENAI_API_KEY'] ?? '',       // DashScope key,作 secret 注入容器
  },
};

// 仅在实际启动 server 时校验，单元测试可跳过
export const validateConfig = () => {
  required('SUPABASE_URL');
  required('SUPABASE_SERVICE_ROLE_KEY');
  if (config.provisioner === 'azure') {
    required('AZURE_SUBSCRIPTION_ID');
    required('AZURE_RESOURCE_GROUP');
    required('AZURE_CONTAINER_APPS_ENV');
    required('AZURE_STORAGE_ACCOUNT');
    required('AZURE_ACR_LOGIN_SERVER');
    required('AZURE_ACR_NAME');
    required('OPENAI_API_KEY');
  }
  if (config.auth.mode === 'wechat') {
    required('WECHAT_APPID');
    required('WECHAT_SECRET');
    required('WECHAT_REDIRECT_URI');
  }
  if ((process.env['SESSION_SECRET'] ?? '').length < 16) {
    console.warn('[config] SESSION_SECRET is short or unset — dev only');
  }
};
