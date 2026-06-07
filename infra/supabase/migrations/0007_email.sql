-- B1: 邮件能力数据面
-- spec: docs/superpowers/specs/2026-06-07-hermes-email-capability-design.md §三
--
-- email_addresses: localpart → user 路由表 (catch-all 入站按 localpart 找 user)
-- emails: 收发邮件内容 (direction 区分 inbound/outbound), 线程关系靠 message_id/in_reply_to/references
-- 注: 附件/原始 eml 的 blob key 列本期建好留空, Blob 存取在后续任务接。

create table email_addresses (
  localpart    text primary key,                          -- @ 前那段, 全局唯一 (catch-all 路由键)
  user_id      uuid not null references users(id) on delete cascade,
  display_name text,                                       -- 发信 From 显示名
  created_at   timestamptz not null default now()
);

create index email_addresses_user on email_addresses (user_id);

create table emails (
  id               text primary key,                      -- 'eml_...'
  user_id          uuid not null references users(id) on delete cascade,
  direction        text not null check (direction in ('inbound','outbound')),
  from_addr        text not null,
  to_addrs         text[] not null default '{}',
  cc_addrs         text[] not null default '{}',
  subject          text not null default '',
  message_id       text,                                  -- 本邮件 Message-ID
  in_reply_to      text,                                  -- 线程头
  reference_ids    text[] not null default '{}',          -- References 头 (列名避开 SQL 关键字 references)
  body_text        text not null default '',              -- 纯文本正文 (入站取去引用后的 reply)
  has_attachments  boolean not null default false,
  raw_blob_key     text,                                  -- 预留: 原始 .eml blob 路径
  attachment_keys  jsonb not null default '[]',           -- 预留: [{name, blob_key, size, content_type}]
  received_at      timestamptz not null default now()
);

create index emails_user_received on emails (user_id, received_at desc);
create index emails_user_message on emails (user_id, message_id);
