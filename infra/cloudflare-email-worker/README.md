# lingxi-email-worker — 部署 + Cloudflare Email Routing

> 交接范围:**只负责 Worker 部署 + `laifu.uncagedai.org` 子域的 Email Routing**。
> Resend 发信、gateway、端到端验证不在此文范围(见 `OWNER-NOTES.md`,由项目方负责)。

## 这个 Worker 干什么

`laifu.uncagedai.org` 收到的邮件 → Email Routing catch-all 投给本 Worker → postal-mime 解析:
- **有附件**:先 `POST {GATEWAY_URL}/api/email/inbound/prepare` 拿每个附件的 write-SAS → 直接 PUT 到 Azure Blob → 再 `POST {GATEWAY_URL}/api/email/inbound`(commit)带 attachment_keys 落库。
- **无附件**:直接 commit。
- 任一步失败 → `message.setReject()` 让发件方 MTA 重投(不丢信)。

部署方式不变(`wrangler deploy`);**不需要给 Worker 任何 Azure 凭据**——写 SAS 由 gateway 签发。

## 🔒 硬约束:账号

**Worker 必须部署在持有 `uncagedai.org` 这个 zone 的那个 Cloudflare 账号。**
Email Routing 规则/Worker/destination 都是账号级资源,不支持跨账号路由;Email Worker 也没有公网投递
地址,由收信流水线在同账号内按名触发。先确认:

```bash
npx wrangler whoami     # 必须能看到 uncagedai.org;若是别的账号(如测试号)先 wrangler login 切过去
```

## 1. 配 GATEWAY_URL(入站回调的 URL 前缀,可配)

Worker POST 的完整地址 = `${GATEWAY_URL}/api/email/inbound`。由项目方提供 `GATEWAY_URL` 值
(本地测=ngrok 隧道地址;固定环境=对应 gateway 域名)。设置方式三选一:

- 部署时覆盖:`npx wrangler deploy --var GATEWAY_URL:https://xxx.ngrok-free.app`
- 或改 `wrangler.toml` 里 `[vars] GATEWAY_URL`
- 本地 `wrangler dev`:复制 `.dev.vars.example` → `.dev.vars` 填 `GATEWAY_URL`(可直接 `http://localhost:9000`)

## 2. 部署 Worker

```bash
cd infra/cloudflare-email-worker
npm install
# 入站密钥(值由项目方给,= gateway 的 inbound 密钥):
echo '<INBOUND_WEBHOOK_SECRET>' | npx wrangler secret put INBOUND_WEBHOOK_SECRET
npx wrangler deploy        # 或带 --var GATEWAY_URL:... (见上)
```

## 3. Cloudflare Email Routing(子域 laifu.uncagedai.org)

Cloudflare 已支持子域 Email Routing。面板 → `uncagedai.org` zone → **Email → Email Routing**:

1. **Settings → Subdomains → 添加 `laifu`**(= `laifu.uncagedai.org`)。
   会给**子域**自动加 MX(`*.mx.cloudflare.net`)+ SPF/DKIM/DMARC。**apex `uncagedai.org` 的 MX 不动**。
2. **Routing rules → Catch-all**(作用域 laifu.uncagedai.org)→ Action **Send to a Worker**
   → 选 `lingxi-email-worker` → 启用。

> 走 API:`POST /zones/{zid}/email/routing/enable` + catch-all 规则 `worker` action;
> token scope 需 `email_routing:write`(wrangler OAuth 默认带)。

## 4. 自检(只验 Worker 这一段通没通)

`npx wrangler tail` 开着,往 `sunco@laifu.uncagedai.org` 发一封测试邮件,应看到:
- Worker 被触发;
- 它向 `${GATEWAY_URL}/api/email/inbound` 发了 POST。
- 发**含附件**的测试邮件时,应额外看到:先一次 `prepare` 调用、一或多次 Azure Blob `PUT`、最后才是 `commit`。
gateway 返回非 2xx 会在 tail 里打 `gateway inbound <code>`(后端是否落库由项目方那边看,不在本文范围)。

常见:catch-all 没指到 Worker → tail 无触发;gateway 回 401 → INBOUND_WEBHOOK_SECRET 两边不一致。

## 回滚

删 catch-all 规则 / 关子域 Routing(apex 阿里邮箱全程未动);删 Worker:`npx wrangler delete`。
