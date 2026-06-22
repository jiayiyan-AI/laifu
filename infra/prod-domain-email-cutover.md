# Prod 域名 + 邮件域切换 Runbook（交给持有 Cloudflare / Resend 权限的执行者）

> 本文档给**持有 Cloudflare（zone `uncagedai.org`）和 Resend 账号权限的执行者**（人或 AI）照着做。
> Azure 侧动作由另一名运维（持 Azure 订阅权限）完成，本文只把它们列为**上下文 + 交接点**，**不需要你做**。
> 执行完每个 Track 的「交接」处，回报给 Azure 运维即可。

---

## 0. 背景与目标（必读，建立上下文）

**产品**：灵犀（laifu）—— 托管版 Agent 平台。后端是一个 Node/Express gateway，跑在 Azure App Service：
- App Service 名：`app-lingxi-prod-gateway`
- 默认域名：`app-lingxi-prod-gateway.azurewebsites.net`（当前网站就在这上面，健康）

**当前状态**
- web：只有默认域名 `app-lingxi-prod-gateway.azurewebsites.net`，没有自定义域。
- 邮件：历史上把 `laifu.uncagedai.org` 用作邮件域（CF Email Routing 入站 → Worker；Resend 出站验过 `laifu.uncagedai.org`）。**prod 的邮件链路尚未接通**（Worker 当前指向 dev），所以现在改动邮件域**不影响任何真实用户**。

**目标（这次要达成的终态）**
- **web 用品牌主域**：`laifu.uncagedai.org` → 指向 App Service（走 **CNAME**）。
- **邮件搬到独立子域**：`mail.laifu.uncagedai.org`（入站 + 出站都用它）。助手邮箱将是 `<名>@mail.laifu.uncagedai.org`。

**为什么这么分**：App Service 自定义域最省心的接法是 CNAME，但**一个 DNS 名不能同时有 CNAME 和 MX**（DNS 硬规则）。`laifu.uncagedai.org` 原来有邮件 MX，挡住了 CNAME。所以把邮件挪到 `mail.laifu.uncagedai.org`，腾出 `laifu.uncagedai.org` 给 web 走 CNAME。

---

## 1. 红线（务必遵守，违反会搞坏现网）

1. **绝不动 apex `uncagedai.org` 的 MX**：它是阿里企业邮箱 `mx*.qiye.aliyun.com`，是公司在用的邮箱,动了会断邮件。我们所有操作都在**子域**上。
2. **指向 App Service 的 CNAME 必须 `DNS only`（灰云，不开橙色代理）**。开了代理 Azure 无法验证域、也签不了托管证书。
3. **不要动 `test.laifu.uncagedai.org`**（测试环境入站路由，保留）和 **`send.laifu.uncagedai.org`**（Resend 旧出站 return-path，保留无害）。
4. CF 不允许同名同时存在 CNAME 与 MX —— 所以**先删 MX，再加 CNAME**，顺序不能反。

---

## 2. 关键固定值（直接用）

| 项 | 值 |
|---|---|
| Cloudflare zone | `uncagedai.org` |
| web 域名 | `laifu.uncagedai.org` |
| CNAME 目标（App Service 默认域名） | `app-lingxi-prod-gateway.azurewebsites.net` |
| App Service 域名所有权验证 ID（asuid TXT 用，若 Azure 侧要） | `1BCEF7974823AC8EEDC7AAEFF515B5B06464F5519D2213202CF971198CE5A419` |
| 邮件域 | `mail.laifu.uncagedai.org` |
| 邮件入站 Worker 名 | `lingxi-email-worker` |
| Resend API base | `https://api.resend.com` |
| Resend 旧域（laifu.uncagedai.org）domain id | `27095b00-6297-44f5-8c74-f3138fee34b4`（旧的，**新域会有新 id**） |

> Resend API key：在持权限方手里（环境变量 `RESEND_API_KEY`，`re_...`）。本文不含明文。

---

## Track 1 — web 拿下 `laifu.uncagedai.org`（走 CNAME）

**目的**：让 `laifu.uncagedai.org` 解析到 App Service，使网站能用品牌域访问。

### 1.1 先撤掉 `laifu.uncagedai.org` 上的邮件路由（删 MX）
- 进 Cloudflare → zone `uncagedai.org` → **Email → Email Routing**。
- 找到作用域为 **`laifu.uncagedai.org`** 的 **catch-all / 路由规则**，删除（或停用该子域的 Email Routing）。
- 确认 `laifu.uncagedai.org` 这个名下**已无 MX 记录**（CF Email Routing 加的 `*.mx.cloudflare.net` 那几条 MX 要一并清掉）。
- ⚠️ 只清 `laifu` 这一名下的 MX。**`test.laifu`、`send.laifu`、apex 的 MX 都不动。**

**校验**：`dig MX laifu.uncagedai.org +short` 应为空。

### 1.2 加 CNAME 指向 App Service
- CF → DNS → 加记录：
  - **类型**：`CNAME`
  - **名称（Name）**：`laifu`（相对 zone，即 `laifu.uncagedai.org`）
  - **目标（Target）**：`app-lingxi-prod-gateway.azurewebsites.net`
  - **代理状态（Proxy）**：**DNS only（灰云）** —— 必须灰云
  - **TTL**：Auto

**校验**：`dig CNAME laifu.uncagedai.org +short` 返回 `app-lingxi-prod-gateway.azurewebsites.net`。

### 1.3 （可选）域名所有权 TXT
- 灰云 CNAME 时 Azure 通常能直接验证所有权，**一般不需要**这条。
- 若 Azure 运维反馈 `hostname add` 要求验证，再加：
  - 类型 `TXT`，名称 `asuid.laifu`，值 `1BCEF7974823AC8EEDC7AAEFF515B5B06464F5519D2213202CF971198CE5A419`，DNS only。

### 1.4 🔔 交接给 Azure 运维
- 回报：「`laifu.uncagedai.org` CNAME 已指向 `app-lingxi-prod-gateway.azurewebsites.net`（灰云），MX 已清」。
- Azure 运维随后会做（**不是你做**）：`az webapp config hostname add` 绑定自定义域 + 申请/绑定免费托管证书 + 重部署让 `PUBLIC_BASE_URL` 切到 `https://laifu.uncagedai.org`。

---

## Track 2 — 邮件搬到 `mail.laifu.uncagedai.org`（入站 CF + 出站 Resend）

> 这条是长线（Resend 验证 + DNS 传播慢），**建议和 Track 1 同时启动**。

### 2.1 入站：CF Email Routing 加子域 `mail.laifu`
- CF → zone `uncagedai.org` → **Email → Email Routing → Settings → Subdomains** → 添加 **`mail.laifu`**（= `mail.laifu.uncagedai.org`）。
  - CF 会**自动**给 `mail.laifu` 加入站 MX（`*.mx.cloudflare.net`）+ 路由用的 SPF/DKIM/DMARC（CF 自管）。
- **Routing rules → Catch-all**，作用域选 **`mail.laifu.uncagedai.org`** → Action **Send to a Worker** → 选 Worker **`lingxi-email-worker`** → 启用。

**校验**：CF Email Routing 里 `mail.laifu.uncagedai.org` 的 catch-all 状态为 active 且指向 `lingxi-email-worker`。

### 2.2 出站：Resend —— 不在本文范围（owner 手动配）
> 出站发信（Resend 验证 `mail.laifu.uncagedai.org`）由 **owner 手动配置，执行者不用碰 Resend**。
> 仅当 owner 把 Resend 生成的 DKIM/SPF/DMARC 记录值发给你时，按「全部 **DNS only / 灰云**」加进 CF；否则本步跳过。

### 2.3 🔔 交接给 Azure 运维
- 回报：「`mail.laifu.uncagedai.org` 入站 catch-all 已指向 `lingxi-email-worker`」（出站 Resend 由 owner 另行确认）。
- Azure 运维随后会做（**不是你做**）：重部署 bicep 让 `EMAIL_DOMAIN=mail.laifu.uncagedai.org` 生效；把 `lingxi-email-worker` 的 `GATEWAY_URL` 指向 prod gateway；对齐 `inbound-webhook-secret`。

---

## 3. 旧记录怎么处理
- 旧 Resend 域 `laifu.uncagedai.org` 的出站记录（`resend._domainkey.laifu`、`send.laifu` 的 MX+SPF、`_dmarc.laifu`）：**先留着，无害**（它们在 `laifu`/`send.laifu`,不影响新 `mail.laifu`）。确认新域跑通后可再清理。
- 旧 `laifu.uncagedai.org` 的 **CF Email Routing**：Track 1.1 已删（因为要给 web 让位)。

---

## 4. 整体顺序与交接点速览

```
Track 1 (web)                         Track 2 (email, 长线先启动)
  1.1 删 laifu 的 MX/路由                2.1 CF 加 mail.laifu 子域 + catch-all → lingxi-email-worker
  1.2 加 CNAME laifu → app...(灰云)       2.2 (Resend 出站 = owner 手动, 不在本文)
  1.3 (可选) asuid TXT
  └─ 交接① → Azure: 绑域+证书+重部署       └─ 交接② → Azure: 重部署(EMAIL_DOMAIN)+worker指prod
                                  最后(Azure 运维 + 你无关): Google OAuth 回调加 https://laifu.uncagedai.org/api/auth/google/callback
```

完成两个交接点的回报后，本执行者的活就结束了。
