const required = (key: string): string => {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
};

export const config = {
  port: parseInt(process.env['PORT'] ?? '9000', 10),
  provisioner: (process.env['PROVISIONER'] ?? 'local') as 'local' | 'azure',
  localContainerUrl: process.env['LOCAL_CONTAINER_URL'] ?? 'http://localhost:8080',
  session: {
    secret: process.env['SESSION_SECRET'] ?? 'dev-only-insecure-secret',
    cookieName: process.env['SESSION_COOKIE_NAME'] ?? 'lingxi_sid',
    ttlHours: parseInt(process.env['SESSION_TTL_HOURS'] ?? '168', 10),
  },
  auth: {
    // 所有 OAuth provider 的凭据集中在这。registry 自己根据这里有没有填决定是否注册。
    providers: {
      google: {
        clientId: process.env['GOOGLE_CLIENT_ID'] ?? '',
        clientSecret: process.env['GOOGLE_CLIENT_SECRET'] ?? '',
      },
    },
    // 「公网可见」的 base URL,用于构造 OAuth redirect_uri、webhook URL 等。
    // 关键: 这里不是 gateway 自己的端口,而是 *用户浏览器看到的入口* —
    // 本地开发用 Vite (:3000),Vite 代理 /api/* 到 gateway (:9000)。
    // 同源好处:cookie 不跨 origin,后端发相对 redirect 就能跳前端路由。
    publicBaseUrl: process.env['PUBLIC_BASE_URL'] ?? 'http://localhost:3000',
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
    // LLM 多 provider 并存,Container 内 hermes-config.yaml 根据 HERMES_MODEL 自动选。
    // Gateway 把所有 LLM env 透传作 secret,容器各取所需。
    hermesModel: process.env['HERMES_MODEL'] ?? 'anthropic/claude-sonnet-4-6',
    anthropicApiKey: process.env['ANTHROPIC_API_KEY'] ?? '',
    dashscopeApiKey: process.env['DASHSCOPE_API_KEY'] ?? '',
    dashscopeBaseUrl: process.env['DASHSCOPE_BASE_URL'] ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1',
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
    // HERMES_MODEL 决定哪个 key 必填
    const model = config.azure.hermesModel;
    if (model.startsWith('anthropic/') && !config.azure.anthropicApiKey) {
      throw new Error(`HERMES_MODEL=${model} 但 ANTHROPIC_API_KEY 未设`);
    }
    if ((model.startsWith('qwen-') || model.startsWith('qwen3-')) && !config.azure.dashscopeApiKey) {
      throw new Error(`HERMES_MODEL=${model} 但 DASHSCOPE_API_KEY 未设`);
    }
  }
  // 至少要有一个 OAuth provider 启用,否则没人能登录
  const enabled = Object.entries(config.auth.providers)
    .filter(([, v]) => v.clientId && v.clientSecret)
    .map(([k]) => k);
  if (enabled.length === 0) {
    throw new Error(
      'No OAuth provider configured. Set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET ' +
      '(or another provider) in your env.',
    );
  }
  console.log(`[config] OAuth providers enabled: ${enabled.join(',')}`);
  if ((process.env['SESSION_SECRET'] ?? '').length < 16) {
    console.warn('[config] SESSION_SECRET is short or unset — dev only');
  }
};
