-- Phase 1.4: 身份模型重塑
-- spec: docs/superpowers/plans/2026-05-31-phase-1.4-google-login-wechat-bind.md §A1
--
-- 设计:users 表本身就承载 OAuth 身份。每个 (provider, external_id) 对应一行。
--   provider:  'google' | 'dev' | 'github' | 'wechat-op' | ...
--   external_id: provider 内稳定 ID (Google: sub; GitHub: id; dev: 任意字符串)
--
-- MVP 阶段不支持「一人多登录方式」(账号关联),合表最简。
-- 以后真要支持账号关联,再拆出 oauth_identities 子表(打破 unique 约束,
-- 引入 user_id 外键)。届时也是可控的迁移。
--
-- container_mapping/threads/context_tokens 全部 FK to users.id,不动。

-- 删 wx_unionid: 它是 dev 阶段拼凑的"假身份",把 users 表跟微信绑死了。
alter table users drop column wx_unionid;

-- 删 wechat_sessions: Phase 1.4 用 wechat_bindings 替代,这表 0 处使用。
drop table if exists wechat_sessions;

-- 加身份字段。先 NULL 以便建索引,再回填(本地无老数据,直接 NOT NULL 也行,
-- 但写法稳妥点便于将来云上迁移)。
alter table users add column if not exists provider text;
alter table users add column if not exists external_id text;
alter table users add column if not exists email text;

-- 老数据无身份,本地是 dev 用 wx_unionid 的——本地随便,这里也用不上;
-- 云上首次部署时此 migration 跑之前 users 表也是空的。
-- 真有数据要保留,可在此处 UPDATE users SET provider='dev', external_id='legacy_'||id;

alter table users alter column provider set not null;
alter table users alter column external_id set not null;

-- 同一 provider 下 external_id 唯一(同一个 Google 账号只能注册一次)
create unique index if not exists users_provider_external_id_unique
  on users (provider, external_id);

-- 邮箱可空(某些 provider 不返);非空时全局唯一(防同邮箱开多账号)
create unique index if not exists users_email_unique
  on users (lower(email))
  where email is not null;
