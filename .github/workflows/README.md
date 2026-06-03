# GitHub Actions

## Workflows

| 文件 | 触发 | 干嘛 |
|---|---|---|
| `gateway-deploy.yml` | push 改 `apps/**` `packages/**` 等 / 手动 | 打 zip → `az webapp deploy` 到 App Service |
| `hermes-image.yml` | push 改 `docker/hermes/**` / 手动 | `az acr build` 推 Hermes 镜像到 ACR |

两个 workflow 都用 **OIDC 联邦认证** (没有长效密钥)，依赖三个 repo secret：

| Secret | 来源 |
|---|---|
| `AZURE_CLIENT_ID` | 给 GitHub 用的 App Registration / Managed Identity 的 client id |
| `AZURE_TENANT_ID` | Azure AD tenant id |
| `AZURE_SUBSCRIPTION_ID` | 目标订阅 |

## 一次性配置 OIDC

```bash
# 1. 建 App Registration
APP_ID=$(az ad app create --display-name lingxi-github-oidc --query appId -o tsv)
SP_ID=$(az ad sp create --id $APP_ID --query id -o tsv)

# 2. 给它 Contributor + User Access Administrator (后者用来给 App Service identity 授 KV 权限)
az role assignment create --role Contributor \
  --assignee $APP_ID --scope /subscriptions/<SUB_ID>
az role assignment create --role 'User Access Administrator' \
  --assignee $APP_ID --scope /subscriptions/<SUB_ID>

# 3. 加联邦凭据 (绑 main 分支)
az ad app federated-credential create --id $APP_ID --parameters '{
  "name": "lingxi-main",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:<OWNER>/<REPO>:ref:refs/heads/main",
  "audiences": ["api://AzureADTokenExchange"]
}'

# 4. repo secrets
echo $APP_ID                                                 # → AZURE_CLIENT_ID
az account show --query tenantId -o tsv                      # → AZURE_TENANT_ID
az account show --query id -o tsv                            # → AZURE_SUBSCRIPTION_ID
```

到 repo Settings → Secrets and variables → Actions → New repository secret，填上面三个。

## 部署目标

资源名按 Bicep 命名规范：

- 部署目标 RG：`rg-lingxi-{env}` (`env` 是 workflow input，默认 `dev`)
- App Service: `app-lingxi-{env}-gateway`
- ACR: `acrlingxi{env}` (但脚本通过 `az acr list -g <rg>` 拿，不依赖名)

## 不在 CI 里

- **Bicep 部署**：手动跑 `infra/bicep/deploy.sh {env}`，理由：基础设施改动罕见，又涉及 RBAC / Key Vault 等敏感操作，不要自动化
- **Key Vault secret 注入**：手动 `az keyvault secret set` 一次性配置，见 `infra/README.md`
