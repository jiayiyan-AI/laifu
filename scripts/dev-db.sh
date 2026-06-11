#!/usr/bin/env bash
# 启动本地 PostgreSQL 容器（替代 supabase start，只起一个 PG，轻量快速）。
# 被 pnpm dev 间接依赖（需要提前跑），或手动 ./scripts/dev-db.sh start。
#
# 端口沿用 54422（与之前 supabase 的 PG 端口一致，.env.local 不用改）。
# 数据持久化在 Docker volume lingxi-pg-data，stop 后数据保留；reset 清数据。
#
# 用法:
#   ./scripts/dev-db.sh start   启动（已存在则跳过）
#   ./scripts/dev-db.sh stop    停止（保留数据）
#   ./scripts/dev-db.sh reset   停止 + 删数据（下次 start 从空库开始，需重新 push+seed）
#   ./scripts/dev-db.sh status  查看状态
#   ./scripts/dev-db.sh logs    查看日志

set -euo pipefail

CONTAINER_NAME="lingxi-pg-dev"
PG_PORT=54422
PG_USER="postgres"
PG_PASSWORD="postgres"
PG_DB="postgres"
VOLUME_NAME="lingxi-pg-data"
PG_IMAGE="postgres:17-alpine"

case "${1:-start}" in
  start)
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
      echo "✅ ${CONTAINER_NAME} 已在运行 (port ${PG_PORT})"
      exit 0
    fi
    # 如果容器存在但停了，先启动
    if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
      docker start "${CONTAINER_NAME}" >/dev/null
      echo "✅ ${CONTAINER_NAME} 已重新启动 (port ${PG_PORT})"
      exit 0
    fi
    # 创建新容器
    docker run -d \
      --name "${CONTAINER_NAME}" \
      -e POSTGRES_USER="${PG_USER}" \
      -e POSTGRES_PASSWORD="${PG_PASSWORD}" \
      -e POSTGRES_DB="${PG_DB}" \
      -p "${PG_PORT}:5432" \
      -v "${VOLUME_NAME}:/var/lib/postgresql/data" \
      "${PG_IMAGE}" >/dev/null
    echo "✅ ${CONTAINER_NAME} 启动完成 (port ${PG_PORT})"
    echo "   连接串: postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${PG_DB}"
    echo "   首次使用需: cd packages/db && DATABASE_URL=postgres://postgres:postgres@localhost:54422/postgres pnpm db:push && pnpm db:seed"
    ;;
  stop)
    docker stop "${CONTAINER_NAME}" 2>/dev/null && echo "✅ 已停止（数据保留）" || echo "⚠️  容器不存在"
    ;;
  reset)
    docker rm -f "${CONTAINER_NAME}" 2>/dev/null || true
    docker volume rm "${VOLUME_NAME}" 2>/dev/null || true
    echo "✅ 容器和数据已清除。下次 start 后需重新 push + seed。"
    ;;
  status)
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
      echo "✅ 运行中 (port ${PG_PORT})"
    elif docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
      echo "⚠️  已停止（docker start ${CONTAINER_NAME} 可恢复）"
    else
      echo "❌ 不存在（./scripts/dev-db.sh start 创建）"
    fi
    ;;
  logs)
    docker logs -f "${CONTAINER_NAME}"
    ;;
  *)
    echo "用法: $0 {start|stop|reset|status|logs}"
    exit 1
    ;;
esac
