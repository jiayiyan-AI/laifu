/**
 * Drizzle schema — 数据访问层的类型权威源。
 *
 * 对应 infra/supabase/migrations/0001~0008。迁移期 (见 docs/drizzle.md §六) schema 变更
 * 仍由 supabase migration 落库，本文件保持与之一致；收口后 schema.ts 成为唯一权威源、
 * 由 drizzle-kit 生成迁移。
 *
 * 约定: JS 属性名用 snake_case，与 @lingxi/shared 的 DB row 类型 + 现有 DAO 行形状一致，
 * 避免迁移期大面积改 key。列名 = 属性名，故第一个参数省略也可，这里显式写出便于对照 SQL。
 */
import {
  pgTable, pgView, pgEnum, uuid, text, timestamp, integer, boolean,
  numeric, bigserial, serial, jsonb, date, primaryKey, uniqueIndex, index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ── users (0001 + 0003 + 0006) ──────────────────────────────────────────
export const users = pgTable('users', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  provider: text('provider').notNull(),
  external_id: text('external_id').notNull(),
  email: text('email'),
  nickname: text('nickname'),
  avatar_url: text('avatar_url'),
  token_version: integer('token_version').notNull().default(0),
  password_hash: text('password_hash'),   // 仅 provider='password' 用户有值;OAuth 用户为 null
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => [
  uniqueIndex('users_provider_external_id_unique').on(t.provider, t.external_id),
  // email 部分唯一索引 (lower(email))：drizzle-kit 暂不完美表达 lower() 表达式索引，
  // 保留在 SQL migration 中即可。迁移期不依赖 drizzle 生成它。
]);

// ── container_mapping (0001) ────────────────────────────────────────────
export const containerMapping = pgTable('container_mapping', {
  user_id: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  container_name: text('container_name').notNull().unique(),
  container_url: text('container_url'),
  status: text('status').notNull(), // 'provisioning' | 'ready' | 'failed' (check 约束留库侧)
  provisioning_step: text('provisioning_step'),
  progress_pct: integer('progress_pct').default(0),
  error_message: text('error_message'),
  azure_files_share: text('azure_files_share'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
  ready_at: timestamp('ready_at', { withTimezone: true }),
});

// ── context_tokens (0001) ───────────────────────────────────────────────
export const contextTokens = pgTable('context_tokens', {
  user_id: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  contact_id: text('contact_id').notNull(),
  token: text('token').notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.user_id, t.contact_id] }),
]);

// ── threads (0001) ──────────────────────────────────────────────────────
export const threads = pgTable('threads', {
  id: text('id').primaryKey(),
  user_id: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  source: text('source').notNull(), // 'web' | 'wechat'
  title: text('title'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  archived: boolean('archived').default(false),
}, (t) => [
  index('threads_user_updated').on(t.user_id, t.updated_at),
]);

// ── wechat_bindings (0005) ──────────────────────────────────────────────
export const wechatBindings = pgTable('wechat_bindings', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  user_id: uuid('user_id').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
  ilink_bot_id: text('ilink_bot_id').notNull().unique(),
  bot_token: text('bot_token').notNull(),
  base_url: text('base_url').notNull(),
  updates_cursor: text('updates_cursor'),
  is_active: boolean('is_active').notNull().default(true),
  thread_id: text('thread_id').references(() => threads.id, { onDelete: 'set null' }),
  bound_at: timestamp('bound_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_wechat_bindings_active').on(t.is_active).where(sql`is_active = true`),
]);

// ── user_entitlements (0006) ────────────────────────────────────────────
export const userEntitlements = pgTable('user_entitlements', {
  user_id: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  feature: text('feature').notNull(),
  enabled_at: timestamp('enabled_at', { withTimezone: true }).notNull().defaultNow(),
  disabled_at: timestamp('disabled_at', { withTimezone: true }),
  metadata: jsonb('metadata'),
}, (t) => [
  primaryKey({ columns: [t.user_id, t.feature] }),
  index('user_entitlements_active').on(t.user_id, t.feature).where(sql`disabled_at is null`),
]);

// ── container_observed_state (0006) ─────────────────────────────────────
export const containerObservedState = pgTable('container_observed_state', {
  user_id: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  observed_entitlements: text('observed_entitlements').array().notNull().default(sql`'{}'`),
  observed_token_version: integer('observed_token_version').notNull().default(0),
  reported_at: timestamp('reported_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── email_addresses (0007) ──────────────────────────────────────────────
export const emailAddresses = pgTable('email_addresses', {
  localpart: text('localpart').primaryKey(),
  user_id: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  display_name: text('display_name'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('email_addresses_user').on(t.user_id),
]);

// ── emails (0007) ───────────────────────────────────────────────────────
export const emails = pgTable('emails', {
  id: text('id').primaryKey(),
  user_id: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  direction: text('direction').notNull(), // 'inbound' | 'outbound'
  from_addr: text('from_addr').notNull(),
  to_addrs: text('to_addrs').array().notNull().default(sql`'{}'`),
  cc_addrs: text('cc_addrs').array().notNull().default(sql`'{}'`),
  subject: text('subject').notNull().default(''),
  message_id: text('message_id'),
  in_reply_to: text('in_reply_to'),
  reference_ids: text('reference_ids').array().notNull().default(sql`'{}'`),
  body_text: text('body_text').notNull().default(''),
  has_attachments: boolean('has_attachments').notNull().default(false),
  raw_blob_key: text('raw_blob_key'),
  attachment_keys: jsonb('attachment_keys').notNull().default(sql`'[]'`),
  received_at: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('emails_user_received').on(t.user_id, t.received_at),
  index('emails_user_message').on(t.user_id, t.message_id),
]);

// ── pricing (0008) ──────────────────────────────────────────────────────
export const pricing = pgTable('pricing', {
  id: serial('id').primaryKey(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  price_in: numeric('price_in', { precision: 12, scale: 4 }).notNull(),
  price_out: numeric('price_out', { precision: 12, scale: 4 }).notNull(),
  price_cached: numeric('price_cached', { precision: 12, scale: 4 }).notNull().default('0'),
  effective_at: timestamp('effective_at', { withTimezone: true }).notNull().defaultNow(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('pricing_provider_model_effective').on(t.provider, t.model, t.effective_at),
]);

// pricing_current — distinct on (provider, model) 取最新生效价。
// 保留为库侧 view (建表在 migration), drizzle 仅 .existing() 声明类型。
export const pricingCurrent = pgView('pricing_current', {
  id: integer('id'),
  provider: text('provider'),
  model: text('model'),
  price_in: numeric('price_in', { precision: 12, scale: 4 }),
  price_out: numeric('price_out', { precision: 12, scale: 4 }),
  price_cached: numeric('price_cached', { precision: 12, scale: 4 }),
  effective_at: timestamp('effective_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }),
}).existing();

// ── usage_events (0008) ─────────────────────────────────────────────────
export const usageEvents = pgTable('usage_events', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  user_id: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  thread_id: text('thread_id').references(() => threads.id, { onDelete: 'set null' }),
  source: text('source').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  input_tokens: integer('input_tokens').notNull().default(0),
  output_tokens: integer('output_tokens').notNull().default(0),
  cache_read_tokens: integer('cache_read_tokens').notNull().default(0),
  cache_write_tokens: integer('cache_write_tokens').notNull().default(0),
  reasoning_tokens: integer('reasoning_tokens').notNull().default(0),
  cost_cny: numeric('cost_cny', { precision: 12, scale: 6 }).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('usage_events_user_time').on(t.user_id, t.created_at),
  index('usage_events_thread').on(t.thread_id, t.created_at).where(sql`thread_id is not null`),
]);

// ── user_balance (0008) ─────────────────────────────────────────────────
export const userBalance = pgTable('user_balance', {
  user_id: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  balance_cny: numeric('balance_cny', { precision: 12, scale: 4 }).notNull().default('0'),
  free_quota_cny_month: numeric('free_quota_cny_month', { precision: 12, scale: 4 }).notNull().default('0'),
  used_cny_month: numeric('used_cny_month', { precision: 12, scale: 4 }).notNull().default('0'),
  period_start: date('period_start').notNull().default(sql`date_trunc('month', now())::date`),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── enums ──────────────────────────────────────────────────────────────────
export const messageRoleEnum = pgEnum('message_role', ['user', 'assistant']);
export const messageContentTypeEnum = pgEnum('message_content_type', ['text', 'json']);
export const messageSourceEnum = pgEnum('message_source', ['web', 'wechat']);
export const agentLoopCompletionEnum = pgEnum('agent_loop_completion', ['success', 'fail', 'limit']);

// ── messages (chat 消息) ──────────────────────────────────────────────
export const messages = pgTable('messages', {
  id: text('id').primaryKey(),                              // gateway 生成 msg_<base36>
  thread_id: text('thread_id').notNull().references(() => threads.id, { onDelete: 'cascade' }),
  role: messageRoleEnum('role').notNull(),
  content_type: messageContentTypeEnum('content_type').notNull().default('text'),
  content: jsonb('content'),                                // 消息内容，根据 content_type 解释
  source: messageSourceEnum('source').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('messages_thread_created').on(t.thread_id, t.created_at),
]);

// ── tool_calls (Agent 工具调用记录，本轮暂不使用) ────────────────────────────
export const toolCalls = pgTable('tool_calls', {
  id: text('id').primaryKey(),                              // gateway 生成 tc_<base36>
  thread_id: text('thread_id').notNull().references(() => threads.id, { onDelete: 'cascade' }),
  message_id: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),                             // 工具名称
  is_success: boolean('is_success'),                        // 调用完成后填; pending 时 null
  parameters: jsonb('parameters').notNull(),                 // 输入参数
  response: jsonb('response'),                              // 输出结果
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  responded_at: timestamp('responded_at', { withTimezone: true }),
}, (t) => [
  index('tool_calls_message').on(t.message_id, t.created_at),
  index('tool_calls_thread').on(t.thread_id, t.created_at),
]);

// ── agent_loops (Agent 循环执行记录) ─────────────────────────────────────
// 每次用户发消息触发的一轮 agent 推理循环 (可能多次 LLM call + tool call)
export const agentLoops = pgTable('agent_loops', {
  id: text('id').primaryKey(),
  thread_id: text('thread_id').notNull().references(() => threads.id, { onDelete: 'cascade' }),
  message_id: text('message_id').references(() => messages.id, { onDelete: 'set null' }), // 触发此循环的 user message
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  iterated_at: timestamp('iterated_at', { withTimezone: true }),  // 上次 LLM call 时间
  iterated_count: integer('iterated_count').notNull().default(0),
  completed_at: timestamp('completed_at', { withTimezone: true }),
  completion: agentLoopCompletionEnum('completion'),         // null = 进行中
}, (t) => [
  index('agent_loops_thread').on(t.thread_id, t.created_at),
  index('agent_loops_active').on(t.thread_id, t.created_at).where(sql`completed_at is null`),
]);
