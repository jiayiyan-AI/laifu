#!/usr/bin/env bash
# 跑 pnpm dev 之前的 prereq 自检。

set -uo pipefail

ok() { echo "  ✅ $1"; }
warn() { echo "  ⚠️  $1"; }
fail() { echo "  ❌ $1"; }

echo "=== 灵犀 dev 环境自检 ==="
echo ""

echo "[Docker]"
if docker info >/dev/null 2>&1; then ok "Docker Desktop 跑着"; else fail "Docker 没启,请先打开 Docker Desktop"; fi
if docker image inspect hermes-probe >/dev/null 2>&1; then ok "image hermes-probe 已 build"; else warn "image hermes-probe 未 build → docker build -t hermes-probe docker/hermes/"; fi

echo ""
echo "[Supabase 本地]"
n=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -c laifu)
if [ "$n" -ge 8 ]; then ok "$n 个 laifu 容器跑着"; else warn "Supabase 本地未启 → cd infra && supabase start"; fi

echo ""
echo "[端口空闲]"
for p in 8080 9000 3000 54321 54322; do
  pid=$(lsof -ti :$p 2>/dev/null || true)
  if [ -z "$pid" ]; then
    case $p in
      54321|54322) warn "port $p 空 (supabase 应占着)" ;;
      *) ok "port $p free" ;;
    esac
  else
    case $p in
      54321|54322) ok "port $p 被 supabase 占着 (pid $pid)" ;;
      *) warn "port $p 被 $pid 占用 → kill -9 $pid" ;;
    esac
  fi
done

echo ""
echo "[配置文件]"
if [ -f apps/gateway/.env.local ]; then ok "apps/gateway/.env.local"; else fail "apps/gateway/.env.local 缺失"; fi
if [ -f docker/hermes/.env ]; then
  model=$(grep -E '^HERMES_MODEL=' docker/hermes/.env | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  if [ -z "$model" ]; then
    warn "docker/hermes/.env: HERMES_MODEL 未设"
  else
    case "$model" in
      anthropic/*)
        key=$(grep -E '^ANTHROPIC_API_KEY=' docker/hermes/.env | head -1 | cut -d= -f2-)
        if [ -n "$key" ]; then ok "HERMES_MODEL=$model + ANTHROPIC_API_KEY 已填"
        else warn "HERMES_MODEL=$model 但 ANTHROPIC_API_KEY 空"; fi ;;
      qwen-*|qwen3-*)
        key=$(grep -E '^DASHSCOPE_API_KEY=' docker/hermes/.env | head -1 | cut -d= -f2-)
        if [ -n "$key" ]; then ok "HERMES_MODEL=$model + DASHSCOPE_API_KEY 已填"
        else warn "HERMES_MODEL=$model 但 DASHSCOPE_API_KEY 空"; fi ;;
      *) warn "HERMES_MODEL=$model (自定义模型,key 校验跳过)" ;;
    esac
  fi
else
  warn "docker/hermes/.env 缺失 → cp docker/hermes/.env.example docker/hermes/.env 填 key"
fi

echo ""
echo "如全 ✅,跑: pnpm dev"
