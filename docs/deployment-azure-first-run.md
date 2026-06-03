# Azure 部署 — 仍需人工注意的事项

代码/Bicep/CI 能自动化的坑都已经修掉了 (`infra/bicep/main.bicep` 加齐 5 个 role assignment + deployer KV 写权限; `scripts/build-deploy.sh` 用 vite lib mode 把 gateway 打成单文件 + 扁平 npm 依赖, 配合 bicep 里 `SCM_DO_BUILD_DURING_DEPLOYMENT=false`, Oryx 不再作妖, CI 直接 `az webapp deploy --type zip`; `parameters.*.json` 默认 `qwen-plus` 对齐 DashScope)。

这份文档现在只留**两类无法靠代码消除的认知陷阱**——Supabase 的 key 体系 + App Service 的 SCM 怪癖。新人接手或部署 prod 时扫一遍即可。

> 流程性的"先做什么再做什么"看 `infra/README.md`; 架构总览看 `docs/deployment.md`; 新环境从零拉起的完整脚本见本文末尾"下次部署 prod 环境的简化版步骤"。

---

## 注意 1: Supabase 的"新 API key"不是 `service_role`

**现象**: 用 `sb_secret_*` 这种新格式 key 调 Supabase, gateway 启动连得上但所有 RLS 检查异常。

**原因**: Supabase 2025 推出了**两套 API key 体系并存**:
- 旧版: `anon` + `service_role`, 都是 JWT (`eyJ...` 开头)
- 新版: "publishable" + "secret", 格式 `sb_publishable_*` / `sb_secret_*`

`@supabase/supabase-js` 客户端 + RLS 默认走**旧版 service_role JWT**。新版的 `sb_secret` 是给 Admin API 用的, 不是一回事。

**解决**: 在 Supabase Dashboard 翻到 **Settings → API → Project API keys**, 往下找 `service_role` (不是默认显眼的位置), 格式必须是 `eyJhbGci...` 一长串。

---

## 注意 2: Kudu publishing password 每次拿都 rotate, basic auth 默认关

**现象 A**: 连续两次 `az webapp deployment list-publishing-credentials` 拿到的 password 不同; 用旧 password 调 SCM API 报 401。

**原因**: 每次调用 `list-publishing-credentials` Azure 会 rotate password (防泄漏)。

**解决**: 每次要调 SCM API 之前**重新拿一次**, 不要存到变量里反复用:

```bash
PASS=$(az webapp deployment list-publishing-credentials -g rg-lingxi-dev -n app-lingxi-dev-gateway --query "publishingPassword" -o tsv)
USER=$(az webapp deployment list-publishing-credentials -g rg-lingxi-dev -n app-lingxi-dev-gateway --query "publishingUserName" -o tsv)
curl -s -u "$USER:$PASS" ...
```

**现象 B**: 第一次用 Kudu API 直接 401, password 完全没机会用到。

**原因**: "SCM Basic Auth Publishing Credentials" 设置默认是关的。

**解决** (一次性):

```bash
az resource update --resource-group rg-lingxi-dev \
  --name scm --namespace Microsoft.Web --resource-type basicPublishingCredentialsPolicies \
  --parent sites/app-lingxi-dev-gateway \
  --set properties.allow=true
```

---

## 注意 3: SCM container 跟 Worker container 看到的 wwwroot 不是同一份

**现象**: 通过 Kudu `https://<app>.scm.azurewebsites.net/api/command` SSH 进去 `ls /home/site/wwwroot/node_modules`, 发现是空的; 但 healthz 又 200, 明明跑得起来。

**原因**: App Service Linux 是**双容器**:
- **SCM container** — Kudu 跑这里, 开 SSH 进去看到的是 wwwroot 的**解压版本** (可写)
- **Worker container (Main)** — Node app 真跑的容器, 跟 SCM 是独立 mount

两个容器**看到的 `/home/site/wwwroot` 不是同一份文件**。

**坑在哪**: 用 Kudu 看到的 wwwroot 状态可能误导你以为 Node app 也是这个状态。

**怎么验证 Node 视角**:
- 不要信 Kudu SSH 看到的 wwwroot
- 真要看 Node 视角, 加一个临时路由 `app.get('/_debug/fs', ...)` 让 Node 自己回答 `process.cwd()` / `fs.readdirSync(...)`
- 或者直接信 healthz/业务路由能跑就是 OK

---

## 下次部署 prod 环境的简化版步骤

按这个顺序, 应该 30 分钟以内完成:

```bash
# 1. Bicep 部署 (deploy.sh 自动取当前用户 AAD Object ID 传给 bicep, 一并授 KV 写权限)
cd infra/bicep
./deploy.sh prod

# 2. 填 KV (按 prod 的真实凭据)
KV=kv-lingxi-prod
az keyvault secret set --vault-name $KV --name session-secret --value "$(openssl rand -hex 32)"
az keyvault secret set --vault-name $KV --name supabase-url --value "..."
az keyvault secret set --vault-name $KV --name supabase-service-role-key --value "..."   # 注意 1: 必须 eyJ... 开头
az keyvault secret set --vault-name $KV --name google-client-id --value "..."
az keyvault secret set --vault-name $KV --name google-client-secret --value "..."
az keyvault secret set --vault-name $KV --name anthropic-api-key --value "TODO"           # 当前 hermes-config.yaml 锁 DashScope, 填占位即可
az keyvault secret set --vault-name $KV --name dashscope-api-key --value "..."

# 3. 跑 Supabase migration
# 浏览器打开 prod project sql editor, 复制 infra/supabase/migrations/*.sql 跑

# 4. 推 Hermes 镜像
cd docker/hermes
ACR_NAME=acrlingxiprod IMAGE_TAG=latest ./build-and-push.sh

# 5. 部署 gateway+web
#    (a) 推 main 触发 CI 自动部署 (需先在 GitHub repo Secrets 配 AZURE_CLIENT_ID/TENANT_ID/SUBSCRIPTION_ID)
#    (b) 或手动跑下面这段:
cd /Users/flyknife/Desktop/laifu
./scripts/build-deploy.sh
cd app-service-deploy && zip -rq ../deploy.zip . -x '*.map' && cd ..
az webapp deploy -g rg-lingxi-prod -n app-lingxi-prod-gateway \
  --src-path deploy.zip --type zip

# 6. Google OAuth Console 加 prod redirect URI
#    https://app-lingxi-prod-gateway.azurewebsites.net/api/auth/google/callback

# 7. 验证
curl https://app-lingxi-prod-gateway.azurewebsites.net/healthz   # 应该 {"ok":true}
```

应用代码每次更新只需重跑步骤 5 (或推 main 走 CI), 不用动 bicep/secret。
