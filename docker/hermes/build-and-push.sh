#!/usr/bin/env bash
# 用 ACR Build 在 Azure 云端构建 Hermes 镜像并推到 ACR。
#
# 为什么用 ACR Build 而不是本地 docker build + push:
#   - 只上传 build context (几十 KB), 不需要 push 整个镜像 (~1GB)
#   - 云端原生 amd64 环境构建, Mac M 系列也能用 (避免 QEMU 模拟)
#   - 用量计入 ACR Tasks (每月前 6000 build-minutes 免费)
#
# 用法:
#   ACR_NAME=acrlingxidev ./build-and-push.sh           # 默认 tag=latest
#   ACR_NAME=acrlingxidev IMAGE_TAG=v1.0.0 ./build-and-push.sh

set -euo pipefail
cd "$(dirname "$0")"

: "${ACR_NAME:?需设置 ACR_NAME (从 Bicep 输出 acrLoginServer 取前缀)}"
IMAGE_TAG="${IMAGE_TAG:-latest}"

echo "[hermes] building '${ACR_NAME}.azurecr.io/hermes:${IMAGE_TAG}' via ACR Build"

az acr build \
  --registry "$ACR_NAME" \
  --image "hermes:${IMAGE_TAG}" \
  --image "hermes:latest" \
  --platform linux/amd64 \
  .

echo ""
echo "[hermes] DONE  ${ACR_NAME}.azurecr.io/hermes:${IMAGE_TAG}"
