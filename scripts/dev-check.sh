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
for p in 8080 3000 5173 54321 54322; do
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
  if grep -q 'sk-ant-your-anthropic-key' docker/hermes/.env 2>/dev/null; then
    warn "docker/hermes/.env 存在但 ANTHROPIC_API_KEY 是占位符"
  else
    ok "docker/hermes/.env (含 ANTHROPIC_API_KEY)"
  fi
else
  warn "docker/hermes/.env 缺失 → cp docker/hermes/.env.example docker/hermes/.env 填 key"
fi

echo ""
echo "如全 ✅,跑: pnpm dev"
