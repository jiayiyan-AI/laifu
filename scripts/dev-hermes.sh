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
  echo "   填 OPENAI_API_KEY 然后重跑:"
  echo "     cp docker/hermes/.env.example $ENV_FILE"
  echo "     vim $ENV_FILE   # 把 OPENAI_API_KEY 改成你的 DashScope key"
  exit 1
fi

if ! grep -q '^OPENAI_API_KEY=sk-' "$ENV_FILE" 2>/dev/null && \
   ! grep -q '^OPENAI_API_KEY=' "$ENV_FILE" | grep -v 'sk-your-dashscope-key' 2>/dev/null; then
  if grep -q 'sk-your-dashscope-key' "$ENV_FILE"; then
    echo "⚠️  $ENV_FILE 里 OPENAI_API_KEY 还是占位符 sk-your-dashscope-key"
    echo "   换成真的 DashScope key 后再跑"
    exit 1
  fi
fi

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
# 把日志直接打到当前 stdout (concurrently 会接收并加前缀)
exec docker run --rm \
  --name "$CONTAINER_NAME" \
  -p 8080:8080 \
  -v "$HOME_VOL":/home/hermes \
  --env-file "$ENV_FILE" \
  "$IMAGE"
