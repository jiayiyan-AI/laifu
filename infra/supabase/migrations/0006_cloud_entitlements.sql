-- P1: Cloud Drive entitlement 控制面闭环
-- spec: docs/superpowers/specs/2026-06-01-cloud-drive-design.md §三 + §四
--
-- 三张改动:
--   1. user_entitlements — 用户开通了哪些 feature（cloud / 未来 wechat_pro ...）
--   2. container_observed_state — 容器 entrypoint 上报实际加载的 skill / token 版本，
--      让前端"启用云盘"等待 modal 能等到容器真生效
--   3. users.token_version — 单调递增计数器；entitlement enable/disable 时 +1，
--      让旧 LAIFU_USER_TOKEN 立刻失效（无需等 90 天 exp）
--
-- 设计要点:
--   - active 定义 = disabled_at IS NULL（不是"行存在"，否则 disable 后再 enable 卡住）
--   - 部分索引只覆盖 active 行，签 SAS 时查询走索引
--   - container_observed_state 单行 per user（PK 是 user_id），上报覆盖
--   - token_version 起步 0；签的第一个 JWT 也带 token_version=0

create table user_entitlements (
  user_id     uuid not null references users(id) on delete cascade,
  feature     text not null,                              -- 'cloud' (P1); 未来 'wechat_pro' 等
  enabled_at  timestamptz not null default now(),
  disabled_at timestamptz,                                -- NULL = active；NOT NULL = 已停用
  metadata    jsonb,                                       -- 留扩展位（套餐版本号 / 备注）
  primary key (user_id, feature)
);

-- active 判定: disabled_at IS NULL。部分索引让 listActive 走索引。
create index user_entitlements_active
  on user_entitlements (user_id, feature)
  where disabled_at is null;

create table container_observed_state (
  user_id                 uuid primary key references users(id) on delete cascade,
  observed_entitlements   text[] not null default '{}',   -- 容器实际软链好的 feature 列表
  observed_token_version  int not null default 0,         -- 容器最后一次重启时 JWT 里的 token_version
  reported_at             timestamptz not null default now()
);

-- users.token_version: 给已存在的行兜底 0。新行默认 0（DEFAULT 子句）。
alter table users
  add column token_version int not null default 0;
