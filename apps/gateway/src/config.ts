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

  // 数据库直连 (Drizzle + node-postgres)。库切换全靠这里的值，不靠代码分支。见 docs/drizzle.md。
  //   本地:   postgres://postgres:postgres@localhost:54422/postgres (./scripts/dev-db.sh start 起的 PG 容器)
  //   云 dev/prod: 云上 Postgres 直连 (当前 Supabase Cloud, direct :5432 / session pooler, 不用 transaction pooler :6543)
  //   (长期可能迁 Azure DB for PostgreSQL, 届时只改这个 URL, 代码不动)
  db: {
    url: process.env['DATABASE_URL'] ?? '',
    ssl: process.env['DATABASE_SSL'] === 'true',        // Azure PG 强制 TLS; 本地 false
    poolMax: parseInt(process.env['DATABASE_POOL_MAX'] ?? '10', 10),
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
    // ⚠️ 镜像版本写死在代码里 (不走 env), 因为改 tag 本就必须连带部署 gateway 才能触发 reconcile
    //   (gateway 启动算 policyHashFor 才会拉齐存量用户)。写死 → 进 git 可 review/revert、零跨文件漂移。
    //   bump 镜像: 改这一行 hermes:vN (单调递增, 禁用 :latest) + 部署 gateway。详见 dynamic-update-aca.md §5.2。
    hermesImageTag: 'hermes:v24',
    // LLM provider 配置 — 容器内 entrypoint.sh 按这些 env 渲染 config.yaml,
    // 改 provider/model 不需要重 build 镜像。
    //   HERMES_PROVIDER  Hermes 一等公民 provider 名 (alibaba / anthropic / openai / deepseek / custom ...)
    //   HERMES_MODEL     具体模型名
    //   HERMES_BASE_URL  alibaba 填 DashScope 国内 endpoint; anthropic/openai 留空; custom 必填
    // LLM API key 不再走 gateway 进程: 真值常驻 KV (secret hermes-api-key), ACA 控制面
    // 带 user-assigned identity 直接拉; gateway 自己根本不接触明文。
    hermesProvider: process.env['HERMES_PROVIDER'] ?? 'alibaba',
    hermesModel: process.env['HERMES_MODEL'] ?? 'qwen3.7-max',
    hermesBaseUrl: process.env['HERMES_BASE_URL'] ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    // HERMES_VISION_MODEL: 主模型不吃原生图时, auxiliary.vision 走的专用 VL 模型名 (alibaba=qwen-vl-max)。
    //   容器 renderConfigYaml 把它写进 config.yaml auxiliary.vision.model; 端点+key 仍由 env
    //   DASHSCOPE_BASE_URL/DASHSCOPE_API_KEY 提供 (绝不写 base_url, 否则被强制 custom→401)。
    //   改 VL 模型只需改这里 + 重部署 gateway, 不必 rebuild hermes 镜像 (旧硬编码映射已从容器删)。
    //   置空 = 不配 auxiliary.vision (主模型本身吃图的 provider 走 native)。
    hermesVisionModel: process.env['HERMES_VISION_MODEL'] ?? 'qwen-vl-max',
    // User-assigned identity bicep 提前建好, ACA 绑它来读 KV hermes-api-key。
    //   resourceId: /subscriptions/.../userAssignedIdentities/id-hermes-<env>
    //               同时用于 ACA template.identity 绑定 + secrets[].identity 引用
    //   kvUri:      https://<kv-name>.vault.azure.net, 拼 keyVaultUrl
    // 两者都从 bicep appSettings 注入, validateConfig 在 prod 启动时强校验。
    hermesAcaIdentityResourceId: process.env['HERMES_ACA_IDENTITY_RESOURCE_ID'] ?? '',
    hermesKvUri: process.env['HERMES_KV_URI'] ?? '',
  },

  cloud: {
    container: process.env['AZURE_STORAGE_CONTAINER'] ?? 'laifu-cloud',
    // 末尾斜杠归一化: env 若误填 ".../" 会拼出 host//container 触发 Azure InvalidUri。
    blobEndpoint: (
      process.env['AZURE_STORAGE_BLOB_ENDPOINT'] ??
      (process.env['AZURE_STORAGE_ACCOUNT']
        ? `https://${process.env['AZURE_STORAGE_ACCOUNT']}.blob.core.windows.net`
        : '')
    ).replace(/\/+$/, ''),
    // User Delegation Key 自身的 TTL（Azure 上限 7d）；缓存使用方在剩余 < 1h 时刷新。
    udkLifetimeSeconds: parseInt(process.env['AZURE_STORAGE_UDK_LIFETIME_SECONDS'] ?? `${7 * 24 * 3600}`, 10),
    // 写 SAS TTL（每个容器拿一次 SAS 用多久）
    writeSasTtlSeconds: parseInt(process.env['AZURE_STORAGE_WRITE_SAS_TTL_SECONDS'] ?? '900', 10),     // 15min
    // 读 SAS TTL（每次 download 签一个）
    readSasTtlSeconds: parseInt(process.env['AZURE_STORAGE_READ_SAS_TTL_SECONDS'] ?? '300', 10),     // 5min
  },

  feishu: {
    // 飞书渠道为常驻能力, 无总开关 (gateway boot 时总起, 0 绑定空跑)。
    // 'feishu' | 'lark' — 决定 API endpoint 域名前缀。
    domain: (process.env['FEISHU_DOMAIN'] ?? 'feishu') as 'feishu' | 'lark',
  },

  email: {
    // 'fake' (dev) | 'resend' (MVP: 入站 CF Email Routing, 出站 Resend)。业务码不分支, 全靠 provider adapter。
    provider: (process.env['EMAIL_PROVIDER'] ?? 'fake') as 'fake' | 'resend',
    // 助手邮箱地址的域名, 如 'mail.lingxi.xxx'。dev fake 下随便填。
    domain: process.env['EMAIL_DOMAIN'] ?? 'mail.localhost',
    // 发信 From 缺省显示名
    fromDefaultName: process.env['EMAIL_FROM_DEFAULT_NAME'] ?? '灵犀助理',
    // 入站 webhook 的 Basic-Auth 共享密钥 (CF Email Worker 与 gateway 共用; Worker 端同名 INBOUND_WEBHOOK_SECRET)
    inboundWebhookSecret: process.env['INBOUND_WEBHOOK_SECRET'] ?? 'dev-inbound-secret',
    // Resend 发信 API key (仅 provider=resend 用)
    resendApiKey: process.env['RESEND_API_KEY'] ?? '',
    // 附件专用 Blob 容器(与云盘 laifu-cloud 分开)
    attachmentContainer: process.env['EMAIL_ATTACHMENT_CONTAINER'] ?? 'email-attachments',
  },

  // OAuth 集成: 授权灵犀代用户操作第三方服务 (GitHub / GitLab / Figma / Google …)。
  // 一张表 (user_oauth_connections) + 一个路由 (oauth/:provider) 统管所有 provider。
  // 接新 provider: providers 里加一项 + integrations/oauth/providers/<id>.ts 加 def + KV 灌 client secret。
  // 与 auth.providers (站内登录身份) 是两回事, 别混 (docs/todo/github.md §一)。
  oauth: {
    // 全 provider 共用一把 token 落库加密 key: 32 字节 base64。AES-256-GCM (Node 内置 crypto)。
    // TODO(暂行, 用户决策 2026-06-25): key 暂内置写死, 不进 Key Vault。env 仍可覆盖。
    //   代价: 任何能读源码者 + DB dump = 解出全部用户 token (key 不再只在 KV)。
    //   因当前尚未接真 OAuth 码流、仅本地/受控 dev 使用, 暂可接受。想通后改回 KV:
    //   灌 oauth-token-encryption-key + 在 kv-secrets.ts/bicep 加回引用 + 删下面这个默认值。
    tokenEncryptionKey:
      process.env['OAUTH_TOKEN_ENCRYPTION_KEY'] ?? '6FFFfXjCq7cf/dUG3Ntkl4oPEvs04Al3LJ7mL6tZL/A=',
    // 每 provider 的 OAuth App 凭证 (clientId 非 secret, clientSecret 走 KV)。
    // scopes / endpoint 是 provider 固有属性, 放 providers/<id>.ts def, 不放这里。
    providers: {
      github: {
        clientId: process.env['GITHUB_OAUTH_CLIENT_ID'] ?? '',
        clientSecret: process.env['GITHUB_OAUTH_CLIENT_SECRET'] ?? '',
        // 仅 provisioner==='local' 生效: 跳过真 OAuth flow, 用本地 gh token 短路绑定 (§六.11)。
        // 其它 provider 无此短路 (依赖 `gh auth token`), 一律 null。
        localDevToken: process.env['GITHUB_LOCAL_DEV_TOKEN'] ?? null,
      },
    } as Record<string, { clientId: string; clientSecret: string; localDevToken: string | null }>,
  },
};

/**
 * 某 OAuth provider 是否可走 connect 流程。
 * - local: 该 provider 配了 localDevToken + 加密 key 即可 (短路, 不需 OAuth App 凭证)
 * - 其它环境: clientId + clientSecret + 加密 key 三者齐
 */
export const oauthConnectEnabled = (provider: string): boolean => {
  if (!config.oauth.tokenEncryptionKey) return false;
  const p = config.oauth.providers[provider];
  if (!p) return false;
  if (config.provisioner === 'local' && p.localDevToken) return true;
  return Boolean(p.clientId && p.clientSecret);
};

// 仅在实际启动 server 时校验，单元测试可跳过
export const validateConfig = () => {
  required('DATABASE_URL');
  if (config.provisioner === 'azure') {
    required('AZURE_SUBSCRIPTION_ID');
    required('AZURE_RESOURCE_GROUP');
    required('AZURE_CONTAINER_APPS_ENV');
    required('AZURE_STORAGE_ACCOUNT');
    required('AZURE_STORAGE_ACCOUNT_NFS');
    required('AZURE_ACR_LOGIN_SERVER');
    if (config.cloud.udkLifetimeSeconds > 7 * 24 * 3600) {
      throw new Error(
        `AZURE_STORAGE_UDK_LIFETIME_SECONDS=${config.cloud.udkLifetimeSeconds} exceeds Azure 7-day UDK max (604800)`,
      );
    }
    // 用户 ACA 的 hermes-api-key secret 走 KV reference, 需要 identity + kv uri 全齐
    required('HERMES_ACA_IDENTITY_RESOURCE_ID');
    required('HERMES_KV_URI');
    if (config.azure.hermesProvider === 'custom' && !config.azure.hermesBaseUrl) {
      throw new Error(`HERMES_PROVIDER=custom 必须设 HERMES_BASE_URL`);
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
  // ── OAuth 集成校验 (docs/todo/github.md §六.3) ──
  const oauth = config.oauth;
  // 加密 key 若配了, 必须解码出 32 字节 (全 provider 共用)
  if (oauth.tokenEncryptionKey) {
    const keyLen = Buffer.from(oauth.tokenEncryptionKey, 'base64').length;
    if (keyLen !== 32) {
      throw new Error(
        `OAUTH_TOKEN_ENCRYPTION_KEY must decode to 32 bytes (got ${keyLen}). Generate: openssl rand -base64 32`,
      );
    }
  }
  const enabledOauth: string[] = [];
  for (const [id, p] of Object.entries(oauth.providers)) {
    const U = id.toUpperCase();
    // dev 短路绝不能进非 local 环境
    if (config.provisioner !== 'local' && p.localDevToken) {
      throw new Error(
        `${U}_LOCAL_DEV_TOKEN set but PROVISIONER!=local — dev shortcut must never reach a cloud env. Unset it.`,
      );
    }
    // OAuth App 凭证要么全配要么全空
    if ([p.clientId, p.clientSecret].filter(Boolean).length === 1) {
      throw new Error(`OAuth ${id}: set both ${U}_OAUTH_CLIENT_ID and ${U}_OAUTH_CLIENT_SECRET, or neither.`);
    }
    // 启用了集成 (有 OAuth 凭证或 dev token) 却没加密 key → token 无处加密
    if ((p.clientId || p.localDevToken) && !oauth.tokenEncryptionKey) {
      throw new Error(`OAuth ${id} enabled but OAUTH_TOKEN_ENCRYPTION_KEY missing.`);
    }
    if (oauthConnectEnabled(id)) enabledOauth.push(id);
  }
  console.log(`[config] OAuth integrations enabled: ${enabledOauth.length ? enabledOauth.join(',') : '(none)'}`);
};
