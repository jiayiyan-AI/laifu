# 灵犀 — Infra

## Supabase
迁移文件在 `supabase/migrations/`。
应用方式（dev 阶段）：在 Supabase Dashboard → SQL Editor 复制粘贴运行 `0001_init.sql`。
Phase 2 之后会切到 supabase CLI 自动化：`supabase db push`。

## Azure (Bicep)

Bicep 模板在 `bicep/`。声明：RG / ACR / Storage / Container Apps Env / Log Analytics / App Service Plan / App Service / Key Vault + RBAC。

### 首次部署 (dev)

```bash
cd bicep
az login
az account set -s <SUB_ID>

# 1. 部署基础设施 (RG 由 deploy.sh 创建)
./deploy.sh dev
# 输出: appServiceHost / acrLoginServer / keyVaultName / 等

# 2. 在 Key Vault 里填 secret (名字必须与 main.bicep 里 SecretName 一致)
KV=kv-lingxi-dev
az keyvault secret set --vault-name $KV --name session-secret --value "$(openssl rand -hex 32)"
az keyvault secret set --vault-name $KV --name gateway-secret --value "$(openssl rand -hex 32)"   # 容器 ↔ gateway JWT 签发密钥
az keyvault secret set --vault-name $KV --name supabase-url --value "https://xxx.supabase.co"
az keyvault secret set --vault-name $KV --name supabase-service-role-key --value "..."   # 必须 eyJ... JWT, 不是 sb_secret_*
az keyvault secret set --vault-name $KV --name google-client-id --value "..."
az keyvault secret set --vault-name $KV --name google-client-secret --value "..."
az keyvault secret set --vault-name $KV --name anthropic-api-key --value "sk-..."
az keyvault secret set --vault-name $KV --name dashscope-api-key --value "sk-..."   # 可填空字符串占位

# 3. App Service 重启拉取 KV reference
az webapp restart -g rg-lingxi-dev -n app-lingxi-dev-gateway

# 4. 推 Hermes 镜像
cd ../../docker/hermes
ACR_NAME=$(az acr list -g rg-lingxi-dev --query "[0].name" -o tsv) ./build-and-push.sh

# 5. 部署 gateway+web
#    推 main 触发 CI 自动跑 .github/workflows/gateway-deploy.yml; 或手动跑:
cd ../..
./scripts/build-deploy.sh                       # 产出 app-service-deploy/
cd app-service-deploy && zip -rq ../deploy.zip . -x '*.map' && cd ..
az webapp deploy -g rg-lingxi-dev -n app-lingxi-dev-gateway \
  --src-path deploy.zip --type zip
curl https://app-lingxi-dev-gateway.azurewebsites.net/healthz   # {"ok":true}
```

### 环境

- `parameters.dev.json` / `parameters.prod.json` — 当前都用 B1 SKU（southeastasia, qwen-plus）。区别只在 `env` 字段和派生的资源命名。规模化后再单独调 prod 的 SKU。

### 不在 Bicep 里的东西

- **每用户 Container App** — gateway 运行时通过 Azure SDK 创建 (`apps/gateway/src/provisioning/azure.ts`)
- **Hermes 镜像** — 单独发布流程 (`docker/hermes/build-and-push.sh`)
- **Gateway+Web 代码** — CI zip 部署 (`.github/workflows/gateway-deploy.yml`)
- **Google OAuth Console** — 手工把 `https://<appServiceHost>/api/auth/google/callback` 加进 redirect URI

详见 `docs/deployment.md`。
