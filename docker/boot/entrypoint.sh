#!/bin/bash
# entrypoint.sh (v5: 切 Bun + TypeScript, 复杂逻辑全在 .ts 脚本里)
#
# 职责:
#   1. seed 初始化 (首次启动从 /home/hermes-seed 拷骨架到 home volume)
#   2. 执行 Bun bootstrap 脚本:
#      - refresh-token.ts        LAIFU_USER_TOKEN 续签 (<7d 才换)
#      - sweep-cache.ts          清 ~/inbox 里 7 天前的渠道附件 + 空目录
#      server 进程并行同步动态文件与 entitlement，再初始化 runtime。
#   3. PID-1 handoff: exec "$@" 把进程让给 bun /app/boot/server/index.ts (来自 Dockerfile CMD)
#
# 注: ACA no_new_privs=true 禁 sudo, 主容器用不了 root; subPath 子目录 owner
# 由 ACA initContainer (init-chown) 在主容器启动前 chown, 见 azure.ts initContainers。
#
# 必需 env (gateway provisioning 注入):
#   GATEWAY_BASE_URL    e.g. https://app-lingxi-dev-gateway.azurewebsites.net
#                       dev: docker-compose / dev-hermes.mjs 传 http://host.docker.internal:9000
#   LAIFU_USER_TOKEN    90d JWT, 缺失则回退读 ~/.hermes/.laifu_user_token

set -e

SEED=/home/hermes-seed
HOME_DIR=/home/hermes
SCRIPTS=/app/boot/scripts

# ============ Step 1: seed 初始化 ============
if [ ! -f "$HOME_DIR/.initialized" ]; then
  echo "[entrypoint] first boot — seeding $HOME_DIR from $SEED"
  cp -a "$SEED/." "$HOME_DIR/" 2>/dev/null || true
  touch "$HOME_DIR/.initialized"
  echo "[entrypoint] seed complete"
else
  echo "[entrypoint] existing home detected, skipping seed"
fi

# ============ Step 2: bootstrap (Bun 脚本统一编排) ============
# export 让 bootstrap 的子进程 (Bun) 以及后续 server.ts / hermes CLI / cloud-publish 都能读到。
export LAIFU_USER_TOKEN
export GATEWAY_BASE_URL

# bootstrap.ts 内部: refresh-token 后清理 cache。
# 动态文件与 entitlement 由 server 在同一进程内并行同步，避免 Pi runtime 跨进程状态。
bun "$SCRIPTS/bootstrap.ts" || echo "[entrypoint] bootstrap errored, continuing to start hermes anyway"

# ============ Step 2.5: token 回灌 env ============
# dev 经 dev-hermes.mjs 启动时不传 LAIFU_USER_TOKEN env, 令牌只落文件
# (~/.hermes/.laifu_user_token, 由 provisioning/local + refresh-token 维护);
# prod 由 azure.ts 以容器 env/secret 注入。而 email/cloud 等技能 CLI 只认
# LAIFU_USER_TOKEN env (os.environ, 无文件兜底) → dev 下 agent 调用必报
# "LAIFU_USER_TOKEN environment variable not set"。
# env 为空就从文件回灌一份, 让 agent 子进程 (及其 bash -l 子命令) 能认证;
# prod env 非空则跳过。放在 bootstrap 之后 → 拿到 refresh-token 续签后的最新值。
# 令牌每次变化都伴随容器重启 (entitlement 改→重签→restart), 故启动快照不会 stale。
if [ -z "${LAIFU_USER_TOKEN:-}" ] && [ -f "$HOME_DIR/.hermes/.laifu_user_token" ]; then
  export LAIFU_USER_TOKEN="$(cat "$HOME_DIR/.hermes/.laifu_user_token")"
  echo "[entrypoint] loaded LAIFU_USER_TOKEN from token file (env was empty)"
fi

# ============ Step 3: 启动主进程 ============
exec "$@"
