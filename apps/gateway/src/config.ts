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
    // gateway 自己对外暴露的 base URL,用于构造 OAuth redirect_uri。
    // 本地开发: gateway 直连端口 :9000。Google 把浏览器 302 到这里命中 callback,
    // gateway 处理完再 302 到 frontendBaseUrl/desktop。
    // 生产: 跟 frontendBaseUrl 同域 (反代分发 /api/*)。
    publicBaseUrl: process.env['PUBLIC_BASE_URL'] ?? 'http://localhost:9000',
    // 前端应用的 base URL,用于 OAuth 成功后跳回 /desktop。
    // 本地开发: Vite (:3000)。生产: 跟 publicBaseUrl 同域,可填 '' 让 gateway 发相对路径。
    frontendBaseUrl: process.env['FRONTEND_BASE_URL'] ?? 'http://localhost:3000',
    // 容器到 gateway 的 JWT 签发密钥；P1 启用后 user_entitlements / refresh-token 都用它。
    // dev 默认是占位值；生产必须显式设。
    gatewaySecret: process.env['GATEWAY_SECRET'] ?? 'dev-only-gateway-secret',
  },
  supabase: {
    url: process.env['SUPABASE_URL'] ?? '',
    serviceRoleKey: process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '',
  },
  azure: {
    subscriptionId: process.env['AZURE_SUBSCRIPTION_ID'] ?? '',
    resourceGroup: process.env['AZURE_RESOURCE_GROUP'] ?? '',
    location: process.env['AZURE_LOCATION'] ?? 'southeastasia',
    containerAppsEnv: process.env['AZURE_CONTAINER_APPS_ENV'] ?? '',
    storageAccount: process.env['AZURE_STORAGE_ACCOUNT'] ?? '',
    // Premium FileStorage account (NFS), 给 hermes home 用。与 storageAccount (StorageV2 云盘) 是两个独立 account。
    // SMB 上 SQLite 锁失败 (known-issues#6), 必须走 NFS。
    storageAccountNfs: process.env['AZURE_STORAGE_ACCOUNT_NFS'] ?? '',
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

  cloud: {
    container: process.env['AZURE_STORAGE_CONTAINER'] ?? 'laifu-cloud',
    blobEndpoint:
      process.env['AZURE_STORAGE_BLOB_ENDPOINT'] ??
      (process.env['AZURE_STORAGE_ACCOUNT']
        ? `https://${process.env['AZURE_STORAGE_ACCOUNT']}.blob.core.windows.net`
        : ''),
    // User Delegation Key 自身的 TTL（Azure 上限 7d）；缓存使用方在剩余 < 1h 时刷新。
    udkLifetimeSeconds: parseInt(process.env['AZURE_STORAGE_UDK_LIFETIME_SECONDS'] ?? `${7 * 24 * 3600}`, 10),
    // 写 SAS TTL（每个容器拿一次 SAS 用多久）
    writeSasTtlSeconds: parseInt(process.env['AZURE_STORAGE_WRITE_SAS_TTL_SECONDS'] ?? '900', 10),     // 15min
    // 读 SAS TTL（每次 download 签一个）
    readSasTtlSeconds: parseInt(process.env['AZURE_STORAGE_READ_SAS_TTL_SECONDS'] ?? '300', 10),     // 5min
  },

  email: {
    // 'fake' (dev, 不真收发) | 'postmark' (prod)。业务码不分支, 全靠 provider adapter。
    provider: (process.env['EMAIL_PROVIDER'] ?? 'fake') as 'fake' | 'postmark',
    // 助手邮箱地址的域名, 如 'mail.lingxi.xxx'。dev fake 下随便填。
    domain: process.env['EMAIL_DOMAIN'] ?? 'mail.localhost',
    // 发信 From 缺省显示名
    fromDefaultName: process.env['EMAIL_FROM_DEFAULT_NAME'] ?? '灵犀助理',
    // 入站 webhook 的 Basic-Auth 共享密钥 (Postmark inbound URL 内嵌 user:pass 里的 pass)
    inboundWebhookSecret: process.env['POSTMARK_INBOUND_WEBHOOK_SECRET'] ?? 'dev-inbound-secret',
    // Postmark 发信 server token (仅 provider=postmark 用)
    postmarkServerToken: process.env['POSTMARK_SERVER_TOKEN'] ?? '',
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
    required('AZURE_STORAGE_ACCOUNT_NFS');
    required('AZURE_ACR_LOGIN_SERVER');
    required('AZURE_ACR_NAME');
    if (config.cloud.udkLifetimeSeconds > 7 * 24 * 3600) {
      throw new Error(
        `AZURE_STORAGE_UDK_LIFETIME_SECONDS=${config.cloud.udkLifetimeSeconds} exceeds Azure 7-day UDK max (604800)`,
      );
    }
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
  if (config.auth.gatewaySecret === 'dev-only-gateway-secret') {
    console.warn('[config] GATEWAY_SECRET is the dev default — set a real one for prod');
  }
};
