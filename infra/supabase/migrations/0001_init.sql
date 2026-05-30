-- 灵犀 MVP 初始 schema
-- spec: docs/superpowers/specs/2026-05-30-lingxi-mvp-spec.md §6

create extension if not exists "pgcrypto";

-- §6.1 users
create table users (
  id         uuid primary key default gen_random_uuid(),
  wx_unionid text unique not null,
  nickname   text,
  avatar_url text,
  created_at timestamptz default now()
);

-- §6.2 container_mapping
create table container_mapping (
  user_id            uuid primary key references users(id) on delete cascade,
  container_name     text not null unique,
  container_url      text,
  status             text not null check (status in ('provisioning','ready','failed')),
  provisioning_step  text,
  progress_pct       int default 0,
  error_message      text,
  azure_files_share  text,
  created_at         timestamptz default now(),
  ready_at           timestamptz
);

-- §6.3 wechat_sessions
create table wechat_sessions (
  user_id        uuid primary key references users(id) on delete cascade,
  bot_token      text not null,
  expires_at     timestamptz not null,
  status         text not null default 'active' check (status in ('active','expired','disabled')),
  bound_wx_nick  text,
  updated_at     timestamptz default now()
);

-- §6.4 context_tokens
create table context_tokens (
  user_id    uuid not null references users(id) on delete cascade,
  contact_id text not null,
  token      text not null,
  updated_at timestamptz default now(),
  primary key (user_id, contact_id)
);

-- §6.5 threads
create table threads (
  id         text primary key,
  user_id    uuid not null references users(id) on delete cascade,
  source     text not null check (source in ('web','wechat')),
  title      text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  archived   boolean default false
);

create index threads_user_updated on threads (user_id, updated_at desc);
