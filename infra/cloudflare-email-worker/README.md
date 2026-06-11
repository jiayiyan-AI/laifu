# lingxi-email-worker — 邮件 MVP 接入 Runbook

> 这份文档**自包含**,可直接交给一个对目标 Cloudflare / Resend 账号有权限的 AI 或人按步执行。
> 目标:让灵犀(laifu)的每个 Hermes 助手通过 `<handle>@laifu.uncagedai.org` 收发邮件。

## 0. 架构与硬约束(先读,否则会白干)

```
入站:  对方发信 → laifu.uncagedai.org (MX→Cloudflare) → Email Routing catch-all
        → 本 Worker (postal-mime 解析) → POST gateway /api/email/inbound (Basic-Auth) → 落库
出站:  gateway /api/email/send → Resend API (验过的 laifu.uncagedai.org) → 对方收到
        From = <handle>@laifu.uncagedai.org, 回信回到子域 MX(Cloudflare)→ 入站闭环
```

- **用子域 `laifu.uncagedai.org`,不动 apex `uncagedai.org`。** apex 的 MX 是阿里企业邮箱,保持不变;
  只在子域上挂 Cloudflare Email Routing。非破坏性。
- **🔒 硬约束:Worker 必须部署在持有 `uncagedai.org` 这个 zone 的那个 Cloudflare 账号里。**
  Email Routing 的规则/Worker/destination 都是**账号级**资源,Cloudflare 不支持跨账号路由到 Worker。
  Email Worker 没有公网投递地址——它由 Cloudflare 收信流水线在**同账号内**按名字触发。
  → 执行前先 `wrangler whoami` 确认登录的账号能看到 `uncagedai.org`。
- 出站为什么用 Resend 而非 Postmark/SES:见仓库 memory `email-postmark-domain-setup`。
  事务商排斥"代用户双向收发"用例,Resend 当 MVP 踏板,生产规划切 SES。

## 1. 前置 / 需要的东西

| 项 | 值 / 来源 |
|---|---|
| 目标子域 | `laifu.uncagedai.org` |
| Worker 名 | `lingxi-email-worker`(见本目录 `wrangler.toml`) |
| Worker 代码 | 本目录 `src/index.ts`(无需改;域名无关,用信封收件人) |
| gateway 入站 Basic-Auth 密钥 | dev = `e00839b743422286cc0c4cdd12ae53993c85e1c0439f31fa`;prod 在 KeyVault `postmark-inbound-webhook-secret` |
| gateway 公网地址 (Worker 的 `GATEWAY_URL`) | dev = ngrok 隧道到本机 :9000;prod = `https://app-lingxi-prod-gateway.azurewebsites.net` |
| Resend 账号 | 需注册;拿 API Key + 能改 Cloudflare DNS 加验证记录 |
| 测试收件地址(已存在 DB) | `sunco@laifu.uncagedai.org` → 用户「顺嘉贸易」 |

## 2. 部署 Worker(在持有 uncagedai.org 的账号)

```bash
cd infra/cloudflare-email-worker
npm install
# 入站密钥(值必须 == gateway 的 POSTMARK_INBOUND_WEBHOOK_SECRET):
echo '<INBOUND_WEBHOOK_SECRET>' | npx wrangler secret put INBOUND_WEBHOOK_SECRET
# 把 wrangler.toml 的 GATEWAY_URL 改成目标 gateway 地址(dev=ngrok / prod=azure), 然后:
npx wrangler deploy
```

## 3. Cloudflare Email Routing(子域)

Cloudflare 已支持子域 Email Routing。面板 → `uncagedai.org` zone → **Email** → **Email Routing**:

1. **Settings → Subdomains → 添加 `laifu`**(即 `laifu.uncagedai.org`)。
   它会给**子域**自动加 MX(`*.mx.cloudflare.net`)+ SPF + DKIM + DMARC。**apex 的阿里 MX 不受影响。**
2. **Routing rules → Catch-all address**(作用于 laifu.uncagedai.org)→ Action: **Send to a Worker**
   → 选 `lingxi-email-worker` → 启用。

> 用 API 而非面板时:`POST /zones/{zid}/email/routing/enable`、规则用 catch-all + `worker` action。
> 需要 token scope:`email_routing:write`(wrangler OAuth 默认带);加子域 MX 若走 DNS API 还需 `dns_records:write`。

## 4. Resend 出站(验子域)

1. Resend 控制台 → Domains → 添加 **`laifu.uncagedai.org`**(用子域,与收信同域,回信才闭环)。
2. 把 Resend 给的 **DKIM(TXT)+ Return-Path/SPF** 记录加到 Cloudflare DNS(都挂在 `laifu` 子域下)。
   - ⚠️ **SPF 一个域只能一条 TXT**:子域上 Email Routing 已写了 `include:_spf.mx.cloudflare.net`,
     要与 Resend 的 include **合并成一条**:`v=spf1 include:_spf.mx.cloudflare.net include:amazonses.com ~all`
     (以 Resend 实际给的为准);别建两条 SPF。
   - 子域 MX 不动(留 Cloudflare 收信)。
3. Verify → 创建 **API Key**。

## 5. gateway 配置

切到 resend provider(本仓 `apps/gateway/src/lib/email/`),三处 env:

| env | dev (`apps/gateway/.env.local`) | prod (bicep appSettings + KV) |
|---|---|---|
| `EMAIL_PROVIDER` | `resend` | `resend` |
| `EMAIL_DOMAIN` | `laifu.uncagedai.org` | `laifu.uncagedai.org` |
| `RESEND_API_KEY` | Resend 的 key | KV `resend-api-key` |
| `POSTMARK_INBOUND_WEBHOOK_SECRET` | 同上那个密钥 | KV `postmark-inbound-webhook-secret` |

dev 已在 `.env.local` 配好 `EMAIL_PROVIDER`/`EMAIL_DOMAIN`,只差填 `RESEND_API_KEY`。
prod 改 `infra/bicep/main.bicep` 三个值 + `az keyvault secret set resend-api-key` + 重启 App Service。

## 6. 端到端验证

- **入站**(Resend 没好也能先验):从外部邮箱(如 Gmail)发一封到 `sunco@laifu.uncagedai.org`。
  几秒后 gateway 应落一条 inbound:`GET /api/email/list`(容器 token)或直接查本地库
  `select * from emails where direction='inbound' order by received_at desc limit 1;`。
  Worker 日志:`npx wrangler tail`。
- **出站**:对该封 `in_reply_to_id` 调 `/api/email/send` 回一封 → Gmail 应收到,且回信能落回入站。

## 7. 线程一致性 / 排错

- 出站 Message-ID:Resend 只回自家 UUID(非 RFC Message-ID),故 resend-provider 自生成
  `<uuid@laifu.uncagedai.org>` 经 headers 带出并入库,保证回信线程头一致。
- 入站没落库:① catch-all 是否指到 worker(`wrangler tail` 看有没有触发);② gateway 401 = 两边密钥不一致;
  ③ 收件人 localpart 在 `email_addresses` 表里没有 → gateway 回 202 dropped(正常,先建 handle)。
- 发不出去:`RESEND_API_KEY` 没填 / 域未 verify / SPF 建了两条。

## 8. 回滚

- 停收信:Cloudflare Email Routing 删 catch-all 规则 / 关子域 Routing(apex 阿里邮箱全程未动)。
- 停发信:gateway `EMAIL_PROVIDER=fake`。
- 删 Worker:`npx wrangler delete`。

---
本地开发:`npx wrangler dev` 起本地 Worker;wrangler 支持发测试 email 事件触发 `email()` handler。
