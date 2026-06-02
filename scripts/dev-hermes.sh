#!/usr/bin/env bash
# 启动本地 Hermes container,被 pnpm dev 调用。
# 终止时(Ctrl+C / concurrently kill)清掉容器。

set -euo pipefail

ENV_FILE="docker/hermes/.env"
IMAGE="hermes-probe"
CONTAINER_NAME="lingxi-hermes-dev"
HOME_VOL="${HOME}/.hermes-dev"

if [ ! -f "$ENV_FILE" ]; then
  echo "⚠️  $ENV_FILE 不存在"
  echo "   先复制模板:  cp docker/hermes/.env.example $ENV_FILE"
  echo "   然后填 ANTHROPIC_API_KEY 或 DASHSCOPE_API_KEY (按 HERMES_MODEL 决定哪个)"
  exit 1
fi

# 读 .env 看选了哪个模型,自动验对应 key
HERMES_MODEL_VALUE=$(grep -E '^HERMES_MODEL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
if [ -z "$HERMES_MODEL_VALUE" ]; then
  echo "⚠️  $ENV_FILE 里没设 HERMES_MODEL"
  echo "   建议: HERMES_MODEL=anthropic/claude-sonnet-4-6"
  exit 1
fi

key_ok() {
  local var=$1
  local val=$(grep -E "^${var}=" "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  [ -n "$val" ]
}

case "$HERMES_MODEL_VALUE" in
  anthropic/*)
    if ! key_ok ANTHROPIC_API_KEY; then
      echo "⚠️  HERMES_MODEL=$HERMES_MODEL_VALUE 需要 ANTHROPIC_API_KEY"
      echo "   申请: https://console.anthropic.com/settings/keys"
      exit 1
    fi
    ;;
  qwen-*|qwen3-*)
    if ! key_ok DASHSCOPE_API_KEY; then
      echo "⚠️  HERMES_MODEL=$HERMES_MODEL_VALUE 需要 DASHSCOPE_API_KEY"
      echo "   申请: https://dashscope.console.aliyun.com/"
      exit 1
    fi
    ;;
  *)
    echo "ℹ️  HERMES_MODEL=$HERMES_MODEL_VALUE  (自定义模型,假设 key 已配)"
    ;;
esac

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "⚠️  image '$IMAGE' 不存在,需要先 build:"
  echo "     docker build -t $IMAGE docker/hermes/"
  echo "   (首次约 10-15 分钟,之后改 server.py 增量约 20 秒)"
  exit 1
fi

# 清掉同名残留(上一次没 graceful 停掉)
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

mkdir -p "$HOME_VOL"

# trap: 收到 SIGTERM/SIGINT 时停容器
cleanup() {
  echo ""
  echo "[hermes] stopping container..."
  docker stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# --rm: 退出自动删
# --name: 固定名字,方便外部停掉
# --add-host: 让容器内 host.docker.internal 解析到 host (Linux Docker 没自动设,Mac/Win 自带)
# -e GATEWAY_BASE_URL: entrypoint 调 /api/me/entitlements 等控制面端点用
#                       host.docker.internal:9000 = host 上跑的 gateway
# 把日志直接打到当前 stdout (concurrently 会接收并加前缀)
exec docker run --rm \
  --name "$CONTAINER_NAME" \
  -p 8080:8080 \
  -v "$HOME_VOL":/home/hermes \
  --add-host=host.docker.internal:host-gateway \
  -e GATEWAY_BASE_URL=http://host.docker.internal:9000 \
  --env-file "$ENV_FILE" \
  "$IMAGE"
