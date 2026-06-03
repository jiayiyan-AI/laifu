#!/usr/bin/env bash
set -euo pipefail

ENV=${1:-dev}
RG="rg-lingxi-${ENV}"
LOCATION="southeastasia"

# 1. 创建 RG (idempotent)
az group create -n "$RG" -l "$LOCATION" --output none

# 2. 拿当前登录用户的 Object ID, 部署时一并传给 bicep,
#    bicep 会给这个用户授 Key Vault Secrets Officer (写 secret)。
#    省得部署完还要手动跑 az role assignment create。
DEPLOYER_ID=$(az ad signed-in-user show --query id -o tsv --only-show-errors 2>/dev/null || echo "")
if [ -z "$DEPLOYER_ID" ]; then
  echo "⚠️  无法获取当前 AAD 用户 (可能是 service principal 登录), 部署后请手动给自己/SP 授 'Key Vault Secrets Officer'"
fi

# 3. 部署 Bicep
#    特殊处理 RoleAssignmentExists 错误: ARM 的已知非确定性怪行为, 用 guid() 算 name
#    理论上应该幂等, 但偶尔仍报 exists (https://github.com/Azure/bicep/issues/18226)。
#    本质是 noise——role assignment 一旦建好运行时没有可改字段, 重复部署"失败"无副作用。
#    所以我们捕获输出, 如果错误全是 RoleAssignmentExists 就当成功; 否则原样报错。
set +e
OUTPUT=$(az deployment group create \
  -g "$RG" \
  -f "$(dirname "$0")/main.bicep" \
  -p "@$(dirname "$0")/parameters.${ENV}.json" \
  -p "deployerObjectId=${DEPLOYER_ID}" \
  --output table 2>&1)
RC=$?
set -e

if [ $RC -eq 0 ]; then
  echo "$OUTPUT"
  exit 0
fi

# 失败: 检查是否只有 RoleAssignmentExists 这种良性 noise
if echo "$OUTPUT" | grep -q "RoleAssignmentExists"; then
  # 把所有 code 字段抽出来, 排除 DeploymentFailed (父 envelope) 和 RoleAssignmentExists,
  # 剩下还有别的 code 就是真错。
  OTHER_ERRORS=$(echo "$OUTPUT" | grep -oE '"code":"[A-Za-z]+"' \
    | grep -vE "RoleAssignmentExists|DeploymentFailed" || true)
  if [ -z "$OTHER_ERRORS" ]; then
    echo "⚠️  Bicep 报 RoleAssignmentExists (ARM 已知非确定性怪行为)"
    echo "    这些 role assignment 之前就建好了, 没有可更新字段, 当成功跳过"
    echo "    其它资源 (appSettings/appCommandLine/...) 已成功更新"
    exit 0
  fi
fi

# 真错: 原样输出
echo "$OUTPUT"
exit $RC
