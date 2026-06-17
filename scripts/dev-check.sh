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
echo "[PostgreSQL 本地]"
if docker ps --format '{{.Names}}' | grep -q "^lingxi-pg-dev$"; then
  ok "lingxi-pg-dev 容器运行中 (port 54422)"
else
  warn "PG 未启 → ./scripts/dev-db.sh start"
fi

echo ""
echo "[端口空闲]"
for p in 9001 9000 3000 54422; do
  pid=$(lsof -ti :$p 2>/dev/null || true)
  if [ -z "$pid" ]; then
    case $p in
      54422) warn "port $p 空 (PG 应占着)" ;;
      *) ok "port $p free" ;;
    esac
  else
    case $p in
      54422) ok "port $p 被 PG 占着 (pid $pid)" ;;
      *) warn "port $p 被 $pid 占用 → kill -9 $pid" ;;
    esac
  fi
done

echo ""
echo "[配置文件]"
if [ -f apps/gateway/.env.local ]; then ok "apps/gateway/.env.local"; else fail "apps/gateway/.env.local 缺失"; fi
if [ -f docker/hermes/.env ]; then
  provider=$(grep -E '^HERMES_PROVIDER=' docker/hermes/.env | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  model=$(grep -E '^HERMES_MODEL=' docker/hermes/.env | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  key=$(grep -E '^HERMES_API_KEY=' docker/hermes/.env | head -1 | cut -d= -f2-)
  base_url=$(grep -E '^HERMES_BASE_URL=' docker/hermes/.env | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  if [ -z "$provider" ] || [ -z "$model" ]; then
    warn "docker/hermes/.env: HERMES_PROVIDER 或 HERMES_MODEL 未设"
  elif [ -z "$key" ]; then
    warn "HERMES_PROVIDER=$provider HERMES_MODEL=$model 但 HERMES_API_KEY 空"
  elif [ "$provider" = "custom" ] && [ -z "$base_url" ]; then
    warn "HERMES_PROVIDER=custom 但 HERMES_BASE_URL 空"
  else
    ok "hermes: provider=$provider model=$model"
  fi
else
  warn "docker/hermes/.env 缺失 → cp docker/hermes/.env.example docker/hermes/.env 填 key"
fi

echo ""
echo "如全 ✅,跑: pnpm dev"
