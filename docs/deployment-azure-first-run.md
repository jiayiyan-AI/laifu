# Azure 部署 — 仍需人工注意的事项

代码/Bicep/CI 能自动化的坑都已经修掉了 (`infra/bicep/main.bicep` 加齐 6 个 role assignment + deployer KV 写权限; `scripts/build-deploy.sh` 用 vite lib mode 把 gateway 打成单文件 + 扁平 npm 依赖, 配合 bicep 里 `SCM_DO_BUILD_DURING_DEPLOYMENT=false`, Oryx 不再作妖, CI 直接 `az webapp deploy --type zip`; `parameters.*.json` 默认 `qwen-plus` 对齐 DashScope)。

这份文档现在留**几类无法靠代码消除的认知陷阱**——KV secret 漂移 + App Service 的 SCM 怪癖 + storage 的 HNS 一次性 flag。新人接手或部署 prod 时扫一遍即可。

> 流程性的"先做什么再做什么"看 `infra/README.md`; 架构总览看 `docs/deployment.md`; 新环境从零拉起的完整脚本见本文末尾"下次部署 prod 环境的简化版步骤"。

---

## 注意 1: KV secret 清单跟着 manifest 走, 用 seed 脚本灌

**现象**: 拿旧版 README / 文档里散落的 `az keyvault secret set` 列表灌 KV, gateway 部署后 `/healthz` 200 但业务路由 500, 或者 KV 里多出一堆没人读的孤儿 secret。

**原因**: 历史上 KV secret 清单只在文档里维护, 没绑代码, 改 bicep / 改 azure.ts 时清单不会自动跟着改, 慢慢就漂了。例:
- 早期用 `@supabase/supabase-js` + RLS, 引用 `supabase-url` / `supabase-service-role-key`; 后来切 Drizzle 直连, 改成 `database-url`。前两个变成孤儿。
- 早期 App Service env 注入 `ANTHROPIC_API_KEY` / `DASHSCOPE_API_KEY` 给 gateway, 实测源码 0 处读取——hermes 容器自己用 `HERMES_API_KEY` 拉 provider-specific 值。两个 env 已从 bicep 删除。

**解决**: 唯一真相来源是 `apps/gateway/src/kv-secrets.ts`。脚本头部 (见 `scripts/seed-kv-secrets.ts` /
`scripts/check-kv-secret-drift.ts`) 有完整的"先决条件 / 跑法 / 行为"文档, 不要在本文重复:

```bash
# 从 repo 根目录跑。详细 flag 与典型场景看脚本头部注释。
pnpm --filter @lingxi/gateway exec tsx ../../scripts/seed-kv-secrets.ts <dev|prod>

# 静态校验 manifest / bicep / azure.ts 三方一致 (CI 也跑这一条)
pnpm --filter @lingxi/gateway exec tsx ../../scripts/check-kv-secret-drift.ts
```

加 / 改 / 删 KV secret 时, **先改 manifest**, 再改其他地方; 否则 azure.ts 编译会报
`Type '...' is not assignable to type 'KvSecretName'`, drift check 会指出 bicep 没对齐。

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

## 注意 4: Storage Account `isHnsEnabled` 是创建时一次性 flag, 改不掉

**现象**: 已存在的 storage account 想给云盘加目录级 SAS 隔离, 直接改 bicep 加 `isHnsEnabled: true` 重部 — 部署成功但 flag 还是 `false`, `az storage container create` 也能建, 但签出的 SAS 走不到 `sr=d`, 多租户隔离失效。

**原因**: ADLS Gen2 的 hierarchical namespace 是**创建时一次性决定**的 storage account 属性, ARM API 接受 update payload 但**会被静默忽略**。

**解决**: 只能**销毁现有 storage account 再重建**。如果是 dev 环境无存量数据, 删 RG → purge KV → 重跑 bicep 是最简单的。生产无法这样做的话, 走"新建一个 HNS account, 跟旧 flat account 并存, 应用层 env 切到新 account"的渐进路径。

```bash
# dev 重建路线 (无存量数据)
az group delete --name rg-lingxi-dev --yes
az keyvault purge --name kv-lingxi-dev --location southeastasia   # purge soft-deleted KV 才能复用同名
cd infra/bicep && ./deploy.sh dev
```

> 同 storage account 同时跑 HNS Blob (云盘) 和 File Share (每用户 Hermes home) 是 OK 的, Azure 支持。不必拆成两个 account。

---

## 注意 5: 给 gateway 的 system identity 加 `Storage Blob Data Owner` 是签 User Delegation Key 的硬条件

**现象**: 云盘 enable 后, 浏览器侧调 `/api/cloud/list` 返回 500 `AuthorizationPermissionMismatch`; gateway 日志显示 `getUserDelegationKey` 403。

**原因**: gateway 用 system identity 找 storage 签 SAS — 但签 UDK (User Delegation Key) **必须** Data 面 role, 不是 control 面 role。Bicep 里 `Storage Account Contributor` 只够建/删 File Share, 不够签 UDK。

**解决**: Bicep 里**两个 role 同时给**:
- `Storage Account Contributor` — 控制面, 建 File Share 给每用户 Hermes home 用
- `Storage Blob Data Owner` — 数据面, 签 UDK 给云盘用 (role def id `b7e6dc6d-f1e8-4753-8033-0f276bb0955b`)

`infra/bicep/main.bicep` 当前两个都有, 不需要再动。但**手工建 storage account 跳过 bicep 时记得补**。

---

## 下次部署 prod 环境的简化版步骤

按这个顺序, 应该 30 分钟以内完成:

```bash
# 1. Bicep 部署 (deploy.sh 自动取当前用户 AAD Object ID 传给 bicep, 一并授 KV 写权限)
cd infra/bicep
./deploy.sh prod

# 2. 填 KV (按 prod 的真实凭据)
# ⚠️ 这一步必须在 Step 5 (deploy gateway zip) 之前完成。
#    顺序反了 → gateway 启动时 KV reference 全部 `SecretNotFound` → node exit 1 →
#    后续灌 secret + az webapp restart 都救不回来, 因为 App Service KV reference cache 不会自动重 resolve。
#    详见 docs/known-issues.md #9。
#    应急手势 (顺序反了之后): `az webapp config appsettings set --settings "KV_REFRESH_TRIGGER=$(date +%s)"`
#
# 先决条件: az login + az account set --subscription <prod sub, 跟 deploy.sh 同一份>
# 详细 flag / 行为见 scripts/seed-kv-secrets.ts 头部
cd <repo root>                                 # 回到 monorepo 根目录 (与下面 step 5 用同一个)
pnpm --filter @lingxi/gateway exec tsx ../../scripts/seed-kv-secrets.ts prod

# 3. Drizzle migration 在 step 5 末尾跑 (App Service deploy 完才有部署单元拿来执行)
#    drizzle/*.sql 文件随 packages/db 打进 zip; 部署单元里 migrate-deploy.mjs 是入口。
#    本地预先验证可在 step 5 之前: DATABASE_URL=<prod database-url> DATABASE_SSL=true \
#      node packages/db/migrate-deploy.mjs
#    详见 packages/db/README.md §部署。

# 4. 推 Hermes 镜像
cd docker/hermes
ACR_NAME=acrlingxiprod IMAGE_TAG=latest ./build-and-push.sh

# 5. 部署 gateway+web
#    (a) 推 main 触发 CI 自动部署 (需先在 GitHub repo Secrets 配 AZURE_CLIENT_ID/TENANT_ID/SUBSCRIPTION_ID)
#    (b) 或手动跑下面这段:
cd /Users/flyknife/Desktop/laifu
./scripts/build-deploy.sh    # 已自动 build shared
cd app-service-deploy && zip -rq ../deploy.zip . -x '*.map' && cd ..
az webapp deploy -g rg-lingxi-prod -n app-lingxi-prod-gateway \
  --src-path deploy.zip --type zip

# 5b. 跑 Drizzle migration (从本地用 prod database-url 跑最快, 不用 ssh 进 worker)
DATABASE_URL=$(az keyvault secret show --vault-name kv-lingxi-prod --name database-url --query value -o tsv) \
  DATABASE_SSL=true \
  node packages/db/migrate-deploy.mjs

# 6. Google OAuth Console 加 prod redirect URI
#    https://app-lingxi-prod-gateway.azurewebsites.net/api/auth/google/callback

# 7. 验证
curl https://app-lingxi-prod-gateway.azurewebsites.net/healthz   # 应该 {"ok":true}
#  云盘流程: 登录 → 创建数字员工 → 启用云盘 → /api/status 看 entitlements_observed:["cloud"]
```

应用代码每次更新只需重跑步骤 5 (或推 main 走 CI), 不用动 bicep/secret。
