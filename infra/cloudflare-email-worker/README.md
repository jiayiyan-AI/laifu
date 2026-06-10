# lingxi-email-worker

MVP 邮件**入站**脑。出站走 Resend(gateway `EMAIL_PROVIDER=resend`),不在这里。

```
对方发信 → uncagedai.org (MX→Cloudflare) → Email Routing catch-all → 本 Worker
         → postal-mime 解析 → POST gateway /api/email/inbound (Basic-Auth) → 落库
```

设计取舍见 memory `email-postmark-domain-setup`:入站用 Cloudflare(免费、不审内容),
出站用 Resend(MVP 踏板,生产规划切 AWS SES)。

## 一次性激活步骤

### 1. 域名 / Cloudflare Email Routing(uncagedai.org)
> ⚠️ 这一步会把 `@uncagedai.org` 的 MX 从阿里企业邮箱切到 Cloudflare,**阿里那个收件箱即作废**(已确认要这么做)。

1. Cloudflare 仪表盘 → uncagedai.org → **Email** → Email Routing → 启用。
   它会自动写入 Cloudflare 的 MX(`*.mx.cloudflare.net`)+ SPF,**替换掉阿里的 `mx*.qiye.aliyun.com`**。
2. **Routing rules → Catch-all → Action: Send to a Worker → 选 `lingxi-email-worker`**(先完成第 3 步部署 Worker 才能选到)。

### 2. Resend 出站(同一个 apex 域)
1. Resend 控制台 → Domains → Add `uncagedai.org`。
2. 把 Resend 给的 **DKIM(TXT)+ SPF/Return-Path** 记录加到 Cloudflare DNS。
   - SPF:Email Routing 已加了一条 `include:_spf.mx.cloudflare.net`;Resend 也要 include。
     **合并成一条** `v=spf1 include:_spf.mx.cloudflare.net include:amazonses.com ~all`(Resend 底层是 SES;以 Resend 实际给的为准),别建两条 TXT。
   - MX 不动(留 Cloudflare 收信)。
3. Verify。拿到 `RESEND_API_KEY`。

### 3. 部署 Worker
```bash
cd infra/cloudflare-email-worker
pnpm install            # 或 npm i
npx wrangler secret put INBOUND_WEBHOOK_SECRET   # 值=gateway 的 POSTMARK_INBOUND_WEBHOOK_SECRET
# 改 wrangler.toml 里 GATEWAY_URL 为目标 gateway (prod azurewebsites / dev ngrok)
npx wrangler deploy
```
部署后回第 1 步把 catch-all 指到它。

### 4. gateway 切到 resend
- **prod**:bicep appSettings 把 `EMAIL_PROVIDER=resend` + `EMAIL_DOMAIN=uncagedai.org`,
  并 `az keyvault secret set` 写入 `resend-api-key`(bicep 已引用)。改完重启 App Service(provider 进程内构建)。
- **dev**:`apps/gateway/.env.local` 设 `EMAIL_PROVIDER=resend` / `EMAIL_DOMAIN=uncagedai.org` /
  `RESEND_API_KEY=...`;Worker 的 `GATEWAY_URL` 指向 ngrok 隧道。

### 5. 端到端验证
- 往 `u-<某用户8hex>@uncagedai.org` 发一封 → gateway 落 inbound 行(`/api/email/list`)。
- 容器侧 `email reply` / `/api/email/send` 发一封 → 对方收到,且回信能落回。

## 本地开发
`npx wrangler dev` 起本地 Worker;`wrangler` 支持发送测试 email 事件触发 `email()` handler。
