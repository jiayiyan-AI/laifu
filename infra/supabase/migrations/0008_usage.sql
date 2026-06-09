-- Token 计量 & 计费基础设施 (v2)
--
-- 三张表:
--   1. pricing        — 模型单价时间线，调价=新增行，旧行不动
--   2. usage_events   — 每次 chat 落一行，记 token 消耗 + 写入时算好的 cost 快照
--   3. user_balance   — 每用户一行，余额 + 本月已用金额 + 免费额度（均为 ¥）
--
-- 设计要点:
--   - usage_events 存 cost_cny 快照：日常聚合直接 sum(cost_cny)，无需 JOIN pricing
--   - pricing 表作为权威价格源，gateway 扣费时查 pricing_current view 算价
--   - 免费额度按金额（free_quota_cny_month），模型无关，避免贵模型亏本
--   - period_start 判断跨月，应用层发现过期时 reset used_cny_month

-- ============================================================
-- 1. pricing — 模型单价表（带时间维度）
-- ============================================================
create table pricing (
  id            serial primary key,
  provider      text not null,                    -- dashscope / anthropic / openrouter
  model         text not null,                    -- qwen3-coder-plus / claude-sonnet-4-20250514
  price_in      numeric(12,4) not null,           -- ¥/百万 input tokens
  price_out     numeric(12,4) not null,           -- ¥/百万 output tokens
  price_cached  numeric(12,4) not null default 0, -- ¥/百万 cached tokens
  effective_at  timestamptz not null default now(),
  created_at    timestamptz not null default now(),

  unique (provider, model, effective_at)
);

-- 便捷 view：每个 provider+model 当前生效的价格
create view pricing_current as
  select distinct on (provider, model) *
  from pricing
  order by provider, model, effective_at desc;

-- 种子数据
insert into pricing (provider, model, price_in, price_out, price_cached, effective_at) values
  ('alibaba', 'qwen3-coder-plus', 4.0,  16.0, 1.0, '2025-06-01'),
  ('alibaba', 'qwen-plus',        0.8,  2.0,  0.2, '2025-06-01'),
  ('anthropic', 'claude-sonnet-4', 22.0, 110.0, 5.5, '2025-06-01');

-- ============================================================
-- 2. usage_events — 每次 chat 的 token 消耗记录
-- ============================================================
create table usage_events (
  id                bigserial primary key,
  user_id           uuid not null references users(id) on delete cascade,
  thread_id         text references threads(id) on delete set null,
  source            text not null,                   -- web / wechat
  provider          text not null,                   -- dashscope / anthropic
  model             text not null,                   -- qwen3-coder-plus / claude-sonnet-4
  input_tokens      int  not null default 0,
  output_tokens     int  not null default 0,
  cache_read_tokens int  not null default 0,
  cache_write_tokens int not null default 0,
  reasoning_tokens  int  not null default 0,
  cost_cny          numeric(12,6) not null,          -- 写入时算好的费用快照（¥）
  created_at        timestamptz not null default now()
);

create index usage_events_user_time on usage_events (user_id, created_at desc);
create index usage_events_thread on usage_events (thread_id, created_at) where thread_id is not null;

-- ============================================================
-- 3. user_balance — 用户余额与免费额度（均为 ¥）
-- ============================================================
create table user_balance (
  user_id              uuid primary key references users(id) on delete cascade,
  balance_cny          numeric(12,4) not null default 0,       -- 充值余额
  free_quota_cny_month numeric(12,4) not null default 0,       -- 每月免费额度（¥）
  used_cny_month       numeric(12,4) not null default 0,       -- 本月已消费（¥）
  period_start         date not null default date_trunc('month', now())::date,
  updated_at           timestamptz not null default now()
);
