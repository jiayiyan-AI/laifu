-- Phase 1.4 B 重写: 微信个人号绑定 via iLink
-- spec: docs/superpowers/plans/2026-06-01-phase-1.4b-wechat-ilink-bind.md §B1
--
-- ⚠️  跟之前 0004 (revert 掉的公众号 wechat_bindings) **同名但 schema 完全不同**。
--     0004 已 revert,本地若残留两张表 (wechat_bindings, wechat_bind_tickets)
--     需要 supabase db reset 或手工 drop。
--
-- 设计要点:
--   - 一个 laifu 用户最多一个微信绑定 — UNIQUE(user_id)
--   - 一个 iLink bot 同一时刻只能被一个 laifu 用户活跃绑定 — UNIQUE(ilink_bot_id),
--     这其实是 iLink 扫码确认流程保证的 (只有微信号所有者能确认),DB 这层是冗余防御
--   - 解绑不删行,置 is_active=false,留作「之前绑过这个号」的历史
--   - 重绑(同号/换号)都走 ON CONFLICT (user_id) DO UPDATE
--   - PollManager.startAll() 用部分索引扫活跃绑定,接近 O(active)

create table wechat_bindings (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null unique references users(id) on delete cascade,
  -- iLink 颁发的 bot id,跨 bot_token 轮换稳定。可作为「这个微信号」的全局标识
  ilink_bot_id    text not null unique,
  -- iLink 颁发的会话凭证,失效后 getupdates 返 errcode=-14
  bot_token       text not null,
  -- iLink 颁发的实际 API base url (登录后可能比 default base url 不同)
  base_url        text not null,
  -- get_updates_buf 长轮询游标,每次推进就 UPDATE 一次
  updates_cursor  text,
  -- session_expired 时改 false; PollManager.startAll 据此筛
  is_active       boolean not null default true,
  -- 1 用户 1 thread (MVP),首条入站消息时创建并写回
  thread_id       text references threads(id) on delete set null,
  bound_at        timestamptz not null default now()
);

-- 仅给活跃行建索引,启动时 PollManager.startAll() 扫描快
create index idx_wechat_bindings_active on wechat_bindings(is_active)
  where is_active = true;
