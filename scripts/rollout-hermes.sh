#!/usr/bin/env bash
# rollout-hermes.sh — 把所有用户的 hermes ACA 批量切到指定镜像 tag。
#
# ACA revision 是不可变快照: push 新镜像到 ACR 后, 现有 ACA 不会自动跟随,
# 必须 `az containerapp update --image` 显式触发新 revision。本脚本就是把
# "对每个 ACA 调一次 update" 的循环封装起来。
#
# 用法:
#   ./scripts/rollout-hermes.sh v9              # 默认环境 dev
#   ENV=dev ./scripts/rollout-hermes.sh v9      # 显式指定
#   DRY_RUN=1 ./scripts/rollout-hermes.sh v9    # 只打印目标列表, 不真跑 update
#   PARALLEL=20 ./scripts/rollout-hermes.sh v9  # 并发度, 默认 10
#
# 前提:
#   - 已 az login + 选对 subscription
#   - tag 必须已经 push 到 ACR (脚本会校验)
#
# 失败处理:
#   xargs 并发跑, 单个 ACA 失败不中断其他。结束后看汇总 (success/failed),
#   失败的 ACA 名字会列出来, 你单独重跑或排查。
#
# 回滚:
#   再跑一遍, tag 换成上一版即可。例如 ./rollout-hermes.sh v8

set -euo pipefail

TAG="${1:-}"
ENV="${ENV:-dev}"
PARALLEL="${PARALLEL:-10}"
DRY_RUN="${DRY_RUN:-0}"

if [[ -z "$TAG" ]]; then
  echo "用法: $0 <image-tag>  (例: $0 v9)" >&2
  exit 1
fi

RG="rg-lingxi-${ENV}"
ACR="acrlingxi${ENV}"
IMAGE="${ACR}.azurecr.io/hermes:${TAG}"

# 校验 tag 在 ACR 存在, 避免把所有 ACA 推到一个不存在的镜像
echo "[rollout] 校验镜像 ${IMAGE} 是否存在于 ACR..."
if ! az acr repository show --name "$ACR" --image "hermes:${TAG}" >/dev/null 2>&1; then
  echo "[rollout] ERROR: ACR ${ACR} 找不到 tag hermes:${TAG}" >&2
  echo "[rollout]        先跑: cd docker/hermes && ACR_NAME=${ACR} IMAGE_TAG=${TAG} ./build-and-push.sh" >&2
  exit 1
fi

# 拉所有 hermes ACA 名字 (兼容 macOS bash 3.2, 不用 mapfile)
echo "[rollout] 扫描 ${RG} 下的 hermes-* ACA..."
ACAS=()
while IFS= read -r line; do
  [[ -n "$line" ]] && ACAS+=("$line")
done < <(az containerapp list -g "$RG" \
  --query "[?starts_with(name,'hermes-')].name" -o tsv)

if [[ ${#ACAS[@]} -eq 0 ]]; then
  echo "[rollout] ${RG} 下没有 hermes-* ACA, 不需要操作"
  exit 0
fi

echo "[rollout] 找到 ${#ACAS[@]} 个 ACA, 准备切到 ${IMAGE} (并发 ${PARALLEL})"
printf '  - %s\n' "${ACAS[@]}"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "[rollout] DRY_RUN=1, 不执行 update"
  exit 0
fi

LOG_DIR="$(mktemp -d)"
echo "[rollout] 单 ACA 日志输出到 ${LOG_DIR}/<name>.log"

# 单个 ACA 的 update 函数。xargs 调它, 每行一个 ACA。
# 成功→输出 OK <name>; 失败→输出 FAIL <name>, 不退出。
update_one() {
  local name="$1"
  local log="${LOG_DIR}/${name}.log"
  if az containerapp update -g "$RG" -n "$name" --image "$IMAGE" >"$log" 2>&1; then
    echo "OK   $name"
  else
    echo "FAIL $name  (log: $log)"
  fi
}
export -f update_one
export RG IMAGE LOG_DIR

printf '%s\n' "${ACAS[@]}" | xargs -P "$PARALLEL" -I {} bash -c 'update_one "$@"' _ {} \
  | tee "${LOG_DIR}/_summary.txt"

OK_COUNT=$(grep -c '^OK   ' "${LOG_DIR}/_summary.txt" || true)
FAIL_COUNT=$(grep -c '^FAIL ' "${LOG_DIR}/_summary.txt" || true)

echo ""
echo "[rollout] 汇总: 成功 ${OK_COUNT}, 失败 ${FAIL_COUNT}, 总计 ${#ACAS[@]}"
if [[ "$FAIL_COUNT" -gt 0 ]]; then
  echo "[rollout] 失败的 ACA:"
  grep '^FAIL ' "${LOG_DIR}/_summary.txt" || true
  exit 1
fi
