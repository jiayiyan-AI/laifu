# Resend 出站发信打通 runbook — laifu.uncagedai.org

> 出站 MVP(Resend 踏板,生产规划切 AWS SES)。**2026-06-16 已端到端跑通**:经 gateway `/api/email/send` 真实业务路径发出,Resend `last_event=delivered` 到 QQ。
> Resend domain id `27095b00-6297-44f5-8c74-f3138fee34b4`,region `us-east-1`。

## 1. DNS 记录(CF zone `uncagedai.org`)

在持有 zone `uncagedai.org` 的 Cloudflare 账户下新增以下 3 条,name 相对 zone 填写,Proxy=DNS only,TTL=Auto。
**红线**:只新增,绝不动 apex `uncagedai.org` 的阿里企业邮箱 MX(mx*.qiye.aliyun.com)。MX 落在 `send.laifu` 子子域,不撞 apex,也不撞将来 CF Email Routing 入站。

| # | 类型 | Name (相对 zone) | 值 | 优先级 |
|---|------|------------------|-----|--------|
| 1 | TXT (DKIM) | `resend._domainkey.laifu` | `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDbyvftRXjXUIEhbFRK70DuXAUmMisSHpHo5b7mJE9AjSSmgD4HXv0yR9bQy+hc6RhQ8RzbSgikVaKfI384UlxZVbUh+HkxO1fvf1QI4ox3KLx1G2PAMWUOJGMX/jj1b610X6hC9iEogowcq6CCg8PCpWJ6204z3zGfnBNCALqj2QIDAQAB` | — |
| 2 | MX (SPF) | `send.laifu` | `feedback-smtp.us-east-1.amazonses.com` | 10 |
| 3 | TXT (SPF) | `send.laifu` | `v=spf1 include:amazonses.com ~all` | — |
| 4 | TXT (DMARC) | `_dmarc.laifu` | `v=DMARC1; p=none; rua=mailto:dmarc@laifu.uncagedai.org; fo=1; adkim=r; aspf=r` | — |

完整 FQDN:`resend._domainkey.laifu.uncagedai.org`(DKIM)、`send.laifu.uncagedai.org`(MX + SPF TXT)、`_dmarc.laifu.uncagedai.org`(DMARC)。

> **DMARC 记录(#4)为何必需**:2026-06-16 Gmail 实测 SPF=PASS、DKIM=PASS(域对齐 laifu.uncagedai.org)、**DMARC=FAIL —— 因为没发布 DMARC 策略**。DKIM 已对齐且 pass,故发布任意合法 DMARC 即变 PASS,无需改 SPF/DKIM。`p=none` 仅监控不拦截。QQ 对 DMARC 不过的新域会静默丢弃(收下回 250 但不进收件箱/垃圾箱),补 DMARC 是让 QQ 有机会收的前提。

## 2. Resend 验域(用 API key 驱动)

```bash
KEY=$(grep -E '^RESEND_API_KEY=' apps/gateway/.env.local | cut -d= -f2-)
DID=27095b00-6297-44f5-8c74-f3138fee34b4
# 建域(已建过则跳过): curl -X POST .../domains -d '{"name":"laifu.uncagedai.org"}'
# DNS 加好后触发 + 轮询:
curl -s -X POST -H "Authorization: Bearer $KEY" https://api.resend.com/domains/$DID/verify
curl -s -H "Authorization: Bearer $KEY" https://api.resend.com/domains/$DID   # 等 status=verified
```

## 3. env(三处守则,dev 已就绪)

- `apps/gateway/.env.local`:`EMAIL_PROVIDER=resend` + `EMAIL_DOMAIN=laifu.uncagedai.org` + `RESEND_API_KEY=<key>`(gitignored,勿提交)
- prod 待翻:`infra/bicep/main.bicep` 把 `EMAIL_PROVIDER` 改 `resend` + `EMAIL_DOMAIN` 改子域 + KV secret `resend-api-key` 填值(本期 dev only,未做)

## 4. 端到端发信验证(dev,走真实 gateway 业务路径)

前提:本地 PG(`supabase_db_laifu` :54422)有一个 user 带 email handle + active `email` entitlement(现成:user `fe83956f-…`,handle `sunco`,display_name `顺嘉贸易`)。

```bash
# 起 gateway(若 :9000 被占用,用 PORT=9100)
cd apps/gateway && PORT=9100 DOTENV_CONFIG_PATH=.env.local pnpm exec tsx -r dotenv/config src/entry.ts &

# 签该 user 的容器 token(token_version 取 DB 当前值,secret=GATEWAY_SECRET 默认 dev-only-gateway-secret)
TOKEN=$(node -e "const j=require('jsonwebtoken');const n=Math.floor(Date.now()/1000);process.stdout.write(j.sign({user_id:'fe83956f-9625-44fe-9b04-6351609779d6',token_version:13,iat:n,exp:n+3600},'dev-only-gateway-secret',{algorithm:'HS256'}))")

# 发
curl -s -X POST http://localhost:9100/api/email/send -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"to":["<收件人>"],"subject":"...","body_text":"..."}'

# 查投递状态(Resend 侧真实 last_event)
curl -s -H "Authorization: Bearer $KEY" https://api.resend.com/emails | python3 -m json.tool
```

期望:gateway 回 `{ok:true,id,message_id}`;DB `emails` 落 outbound 行;Resend `last_event=delivered`。

## 5. 已知 / 待办

- "delivered" = 收件服务器接收,不保证进收件箱。Gmail 实测可进收件箱(SPF/DKIM pass);QQ 对新域静默丢弃。DMARC 已列为记录 #4(必补)。进一步改善靠域预热 + 发信声誉积累。
- Resend 是**踏板**:AUP "opt-in 到我" 墙 + 封号快,生产出站规划切 **AWS SES**(过 production-access 审核)。见 memory `email-postmark-domain-setup`。
- 入站(CF Email Routing → `/api/email/inbound`)是另一条链路,本 runbook 只覆盖出站。回信闭环需入站也配通。
