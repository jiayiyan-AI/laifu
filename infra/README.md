# 灵犀 — Infra

## Supabase
迁移文件在 `supabase/migrations/`。
应用方式（dev 阶段）：在 Supabase Dashboard → SQL Editor 复制粘贴运行 `0001_init.sql`。
Phase 2 之后会切到 supabase CLI 自动化：`supabase db push`。

## Azure (Bicep)
Bicep 模板在 `bicep/`。详见 Task 12 + 13。
