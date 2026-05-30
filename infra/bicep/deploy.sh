#!/usr/bin/env bash
set -euo pipefail

ENV=${1:-dev}
RG="rg-lingxi-${ENV}"
LOCATION="eastasia"

# 1. 创建 RG (idempotent)
az group create -n "$RG" -l "$LOCATION" --output none

# 2. 部署 Bicep
az deployment group create \
  -g "$RG" \
  -f "$(dirname "$0")/main.bicep" \
  -p "@$(dirname "$0")/parameters.${ENV}.json" \
  --output table
