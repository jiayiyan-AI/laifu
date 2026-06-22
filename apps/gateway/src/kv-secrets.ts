/**
 * ★ Single source of truth for KV secrets this app depends on. ★
 *
 * 想加 / 删 / 改名一个 KV secret? 从这开始改:
 *   1. 在 KV_SECRETS 里增删 entry
 *   2. typecheck 会指出 azure.ts 等代码侧需要同步的地方
 *   3. (后续会有 scripts/check-kv-secret-drift.ts 验证 bicep 引用对齐)
 *   4. (后续会有 scripts/seed-kv-secrets.ts 按 seed 字段在 prod/dev 灌值)
 *
 * 这份 manifest 故意不依赖 config.ts / 任何运行时配置, 让种子脚本和漂移检查
 * 能干净地 import 它, 不被 process.env 拖累。
 *
 * Consumer 字段命名规约:
 *   'gateway.env.<NAME>'    bicep appSettings 里
 *                           NAME: '@Microsoft.KeyVault(...SecretName=<key>)'
 *   'aca-hermes.env.<NAME>' azure.ts createContainerApp 里
 *                           env [{ name: NAME, secretRef: '<key>' }]
 *                           + secrets [{ name: '<key>', keyVaultUrl: ..., identity }]
 */

export type KvSecretSeed =
  /** 运维 terminal prompt 粘贴; hint 是格式示例 */
  | { readonly kind: 'prompt'; readonly hint: string }
  /** 自动跑 shell 命令生成 (e.g. openssl rand -hex 32) */
  | { readonly kind: 'generate'; readonly cmd: string }
  /** 当前未启用, 灌一个占位让 KV reference 不至于解析失败 */
  | { readonly kind: 'placeholder'; readonly value: string };

export interface KvSecretSpec {
  /** 一句话用途, 上线 N 年后仍能让人看懂 */
  readonly description: string;
  /** 真值哪来 (第三方控制台路径 / 自生成 / placeholder) */
  readonly source: string;
  /** 谁消费; 见文件头格式说明 */
  readonly consumers: readonly string[];
  /** 缺失时 seed 脚本怎么补 */
  readonly seed: KvSecretSeed;
}

export const KV_SECRETS = {
  'hermes-api-key': {
    description:
      'LLM provider API key (DashScope / Anthropic / OpenAI 等); 用户 ACA 容器拉来调 LLM',
    source: 'provider 控制台 (按 HERMES_PROVIDER 选, 例: DashScope console)',
    consumers: ['aca-hermes.env.HERMES_API_KEY'],
    seed: { kind: 'prompt', hint: 'sk-... 或 sk-ant-... 等' },
  },
  'database-url': {
    description: 'Postgres 连接串 (Drizzle + node-postgres 直连)',
    source: 'Supabase Cloud / Azure PG 控制台',
    consumers: ['gateway.env.DATABASE_URL'],
    seed: {
      kind: 'prompt',
      hint: 'postgresql://user:pass@host:port/db?sslmode=require',
    },
  },
  'session-secret': {
    description: 'Express session 签名 key',
    source: '自生成',
    consumers: ['gateway.env.SESSION_SECRET'],
    seed: { kind: 'generate', cmd: 'openssl rand -hex 32' },
  },
  'gateway-secret': {
    description: 'JWT 签发密钥 (gateway ↔ hermes 容器 LAIFU_USER_TOKEN)',
    source: '自生成',
    consumers: ['gateway.env.GATEWAY_SECRET', 'aca-hermes.env.GATEWAY_SECRET'],
    seed: { kind: 'generate', cmd: 'openssl rand -hex 32' },
  },
  'google-client-id': {
    description: 'Google OAuth client ID (登录唯一启用的 provider)',
    source: 'Google Cloud Console → APIs & Services → Credentials',
    consumers: ['gateway.env.GOOGLE_CLIENT_ID'],
    seed: { kind: 'prompt', hint: '<...>.apps.googleusercontent.com' },
  },
  'google-client-secret': {
    description: 'Google OAuth client secret',
    source: 'Google Cloud Console → APIs & Services → Credentials',
    consumers: ['gateway.env.GOOGLE_CLIENT_SECRET'],
    seed: { kind: 'prompt', hint: 'GOCSPX-...' },
  },
  'resend-api-key': {
    description: 'Resend 出站发信 API key',
    source: 'Resend 控制台 → API Keys',
    consumers: ['gateway.env.RESEND_API_KEY'],
    seed: { kind: 'prompt', hint: 're_...' },
  },
  'inbound-webhook-secret': {
    description:
      '入站 webhook Basic-Auth 共享密钥 (CF Email Worker ↔ gateway /api/email/inbound)',
    source: '自生成',
    consumers: ['gateway.env.INBOUND_WEBHOOK_SECRET'],
    seed: { kind: 'generate', cmd: 'openssl rand -hex 32' },
  },
} as const satisfies Record<string, KvSecretSpec>;

/** Compile-time union of all valid KV secret names. azure.ts/scripts 引用时拿这个做强类型。 */
export type KvSecretName = keyof typeof KV_SECRETS;
