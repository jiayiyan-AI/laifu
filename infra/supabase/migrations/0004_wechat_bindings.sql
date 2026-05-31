-- Phase 1.4 B: 微信公众号扫码绑定
-- spec: docs/superpowers/plans/2026-05-31-phase-1.4-google-login-wechat-bind.md §B1
--
-- 两张表分别承担不同职责:
--   wechat_bindings        — 已绑定关系 (user_id ↔ mp_openid),终态。
--   wechat_bind_tickets    — 绑定过程中的 ticket (二维码 scene_str 关联),临态。
--
-- 流程:
--   1. POST /api/wechat/bind/start  → 生成 token(scene_str=bind_{token}),
--                                     调微信 qrcode/create 得 ticket_url,
--                                     INSERT wechat_bind_tickets(token, user_id, ticket_url, expires_at)
--   2. 用户扫码 → 微信 webhook subscribe/SCAN 携带 scene_str=bind_{token} + FromUserName(openid)
--                webhook 处理: UPDATE wechat_bind_tickets SET mp_openid=...,
--                              INSERT INTO wechat_bindings ON CONFLICT DO NOTHING
--   3. 前端轮询 /api/wechat/bind/status?token=... → 读 wechat_bind_tickets/wechat_bindings 判定
--
-- mp_openid 全局唯一: 一个微信号只能绑一个灵犀账号 (双向 1:1)。

create table wechat_bindings (
  user_id    uuid primary key references users(id) on delete cascade,
  mp_openid  text not null unique,
  bound_at   timestamptz not null default now()
);

create table wechat_bind_tickets (
  token       text primary key,                                   -- random 16-byte hex,也是 scene_str 后缀
  user_id     uuid not null references users(id) on delete cascade,
  ticket_url  text not null,                                      -- mp.weixin.qq.com/cgi-bin/showqrcode?ticket=...
  mp_openid   text,                                               -- NULL 直到 webhook 命中
  expires_at  timestamptz not null,                               -- now() + 10min,与微信 qrcode expire_seconds 对齐
  created_at  timestamptz not null default now()
);

create index idx_wechat_bind_tickets_user_id on wechat_bind_tickets(user_id);
