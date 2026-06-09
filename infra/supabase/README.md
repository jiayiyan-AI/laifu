# Supabase 本地开发指南

## 概述

本项目用 Supabase **纯粹当 Postgres + PostgREST 使用**——提供一个带 REST API 的关系数据库，存用户、容器映射、会话、权益等业务数据。Supabase 的 Realtime / Storage / Edge Functions 等高级功能均未使用（`config.toml` 中已关闭）。

前端**不直接**连 Supabase；所有数据操作都经 gateway API，gateway 以 service_role key 调用 PostgREST。

## 运行位置

本地 Supabase 由 Supabase CLI 拉起的一组 Docker 容器组成：

| 容器 | 端口 | 作用 |
|------|------|------|
| `supabase_kong_laifu` | **:54421** | API 网关（PostgREST 入口） |
| `supabase_db_laifu` | **:54422** | Postgres 17 |
| `supabase_studio_laifu` | **:54423** | Web 管理面板 |
| `supabase_rest_laifu` | 内部 | PostgREST |
| `supabase_auth_laifu` | 内部 | GoTrue（项目未直接使用） |
| `supabase_pg_meta_laifu` | 内部 | Studio 元数据服务 |

> **端口约定**：laifu 所有 supabase 端口 +100（默认 54321 → 54421），避免和同机器其他 supabase 项目（如 dumare）冲突。

Gateway 连接路径：
```
gateway :9000
  → http://localhost:54421 (Kong)
    → PostgREST
      → Postgres :54422
```

## 日常命令

```bash
cd infra/supabase

supabase start             # 启动（首次拉镜像较慢，之后秒起）
supabase stop              # 停止容器（数据保留在 Docker volume）
supabase stop --no-backup  # 停止并删除数据（干净重来）
supabase status            # 查看各服务 URL / key
supabase db reset          # 清库 + 重跑所有 migrations + seed
```

### Web Studio

```bash
open http://localhost:54423
```

### 直连 Postgres

```bash
psql postgresql://postgres:postgres@localhost:54422/postgres
```

## 与 `pnpm dev` 的关系

`pnpm dev` 只启动 hermes + gateway + web，**不会自动起 Supabase**。需要提前手动启动：

```bash
cd infra/supabase && supabase start
```

启动后可用 `pnpm dev:check` 一键验证（检查 Docker、Supabase 容器数量、端口占用、env 文件）。

## env 配置

`apps/gateway/.env.local` 中需要两个值：

```env
SUPABASE_URL=http://localhost:54421
SUPABASE_SERVICE_ROLE_KEY=<supabase start 输出里的 service_role key>
```

本地 Supabase 的 JWT secret 是写死的 demo 值，所以 service_role key **每台机器都一样**，不用自己生成。首次 `supabase start` 会打印出来，直接复制即可。

也支持连 Supabase Cloud dev 项目（多设备/手机调试时更方便）：

```env
SUPABASE_URL=https://<dev-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<Dashboard → Settings → API → service_role>
```

## Migrations 管理

所有 migration 文件在 `infra/supabase/migrations/`：

```
0001_init.sql                    — users, container_mapping, wechat_sessions, context_tokens, threads
0003_oauth_identities.sql        — OAuth 多 provider 支持
0005_wechat_ilink_bindings.sql   — 微信 iLink 绑定
0006_cloud_entitlements.sql      — 云盘权益
0007_usage.sql                   — 用量表
```

`supabase start` 会自动执行所有 migration。

### 新增 migration

```bash
cd infra/supabase
supabase migration new <name>   # 生成 migrations/xxxx_<name>.sql，手动写 SQL
supabase db reset               # 验证全部 migration 从零能跑通
```

## 关闭的功能

`config.toml` 中明确关闭了以下服务以节省本地资源：

- **Realtime** — 没用 websocket 订阅
- **Storage** — 用 Azure Blob
- **Edge Runtime** — 没用 edge functions
- **Inbucket** — 没用 email auth
- **Analytics** — dev 不需要 Logflare

## 数据持久性

- `supabase stop` 默认保留数据（Docker volume 不删）
- `supabase stop --no-backup` 或 `supabase db reset` 才会清数据
- 如果 Docker Desktop 重置或删 volume，数据丢失，需重新 `supabase start`（会自动重建 + 跑 migration）
