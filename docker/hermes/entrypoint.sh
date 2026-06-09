#!/bin/bash
# entrypoint.sh (v4: 薄壳, 复杂逻辑全在 Node 脚本里)
#
# 职责:
#   1. seed 初始化 (首次启动从 /home/hermes-seed 拷骨架到 home volume)
#   2. 依次调 Node bootstrap 脚本:
#      - refresh-token.mjs       LAIFU_USER_TOKEN 续签 (<7d 才换)
#      - pull-runtime-config.mjs 拉 /api/me/runtime-config 渲染 config.yaml
#      - sync-entitlements.mjs   拉 /api/me/entitlements 软链 skill + 上报 observed
#   3. PID-1 handoff: exec "$@" 把进程让给 python server.py (来自 Dockerfile CMD)
#
# 注: ACA no_new_privs=true 禁 sudo, 主容器用不了 root; subPath 子目录 owner
# 由 ACA initContainer (init-chown) 在主容器启动前 chown, 见 azure.ts initContainers。
#
# 必需 env (gateway provisioning 注入):
#   GATEWAY_BASE_URL    e.g. https://app-lingxi-dev-gateway.azurewebsites.net
#                       dev: docker-compose / dev-hermes.sh 传 http://host.docker.internal:9000
#   LAIFU_USER_TOKEN    90d JWT, 缺失则回退读 ~/.hermes/.laifu_user_token

set -e

SEED=/home/hermes-seed
HOME_DIR=/home/hermes
SCRIPTS=/opt/lingxi-scripts

# ============ Step 1: seed 初始化 ============
if [ ! -f "$HOME_DIR/.initialized" ]; then
  echo "[entrypoint] first boot — seeding $HOME_DIR from $SEED"
  cp -a "$SEED/." "$HOME_DIR/" 2>/dev/null || true
  touch "$HOME_DIR/.initialized"
  echo "[entrypoint] seed complete"
else
  echo "[entrypoint] existing home detected, skipping seed"
fi

# ============ Step 2: bootstrap (Node 脚本统一编排) ============
# export 让 bootstrap 的子进程 (Node) 以及后续 server.py / hermes CLI / cloud-publish 都能读到。
export LAIFU_USER_TOKEN
export GATEWAY_BASE_URL

# bootstrap.mjs 内部: refresh-token (串行) → [pull-runtime-config || sync-entitlements] (并行)。
# 任何子步骤失败都不致命, bootstrap 自己吞错继续往下走, 让 hermes server 仍能起来。
node "$SCRIPTS/bootstrap.mjs" || echo "[entrypoint] bootstrap errored, continuing to start hermes anyway"

# source runtime env (provider/model) 供 server.py 读取
if [ -f "$HOME_DIR/.hermes/.runtime_env" ]; then
  set -a
  . "$HOME_DIR/.hermes/.runtime_env"
  set +a
fi

# ============ Step 3: 启动主进程 ============
exec "$@"
