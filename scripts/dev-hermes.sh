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
  echo "   然后填 HERMES_API_KEY (按 HERMES_PROVIDER 选对应 provider 的 key)"
  exit 1
fi

read_env() {
  grep -E "^${1}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true
}

HERMES_PROVIDER_VALUE=$(read_env HERMES_PROVIDER)
HERMES_MODEL_VALUE=$(read_env HERMES_MODEL)
HERMES_API_KEY_VALUE=$(read_env HERMES_API_KEY)
HERMES_BASE_URL_VALUE=$(read_env HERMES_BASE_URL)

if [ -z "$HERMES_PROVIDER_VALUE" ] || [ -z "$HERMES_MODEL_VALUE" ]; then
  echo "⚠️  $ENV_FILE 缺 HERMES_PROVIDER 或 HERMES_MODEL"
  exit 1
fi
if [ -z "$HERMES_API_KEY_VALUE" ]; then
  echo "⚠️  HERMES_API_KEY 未设 (provider=$HERMES_PROVIDER_VALUE)"
  case "$HERMES_PROVIDER_VALUE" in
    anthropic) echo "   申请: https://console.anthropic.com/settings/keys" ;;
    alibaba)   echo "   申请: https://dashscope.console.aliyun.com/" ;;
    custom)    echo "   custom provider 需要对应端点的 API key" ;;
  esac
  exit 1
fi
if [ "$HERMES_PROVIDER_VALUE" = "custom" ] && [ -z "$HERMES_BASE_URL_VALUE" ]; then
  echo "⚠️  HERMES_PROVIDER=custom 必须设 HERMES_BASE_URL"
  exit 1
fi
echo "ℹ️  hermes provider=$HERMES_PROVIDER_VALUE model=$HERMES_MODEL_VALUE"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "⚠️  image '$IMAGE' 不存在,需要先 build:"
  echo "     docker build -t $IMAGE docker/hermes/"
  echo "   (首次约 10-15 分钟,之后改 server/*.ts 增量约 20 秒)"
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
  -p 9001:8080 \
  -v "$HOME_VOL":/home/hermes \
  --add-host=host.docker.internal:host-gateway \
  -e GATEWAY_BASE_URL=http://host.docker.internal:9000 \
  --env-file "$ENV_FILE" \
  "$IMAGE"
