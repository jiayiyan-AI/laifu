# 邮件 MVP — 项目方负责的部分

`README.md` 只覆盖 Worker + Email Routing(交给有 CF 账号权限的人)。这里是**其余由项目方自己做**的:
出站 Resend、gateway 配置、端到端验证。背景/选型见 memory `email-postmark-domain-setup`。

## 出站:Resend(验子域 laifu.uncagedai.org)

1. Resend 控制台 → Domains → 加 **`laifu.uncagedai.org`**(与收信同子域,回信才闭环)。
2. 把 Resend 给的 **DKIM(TXT)+ Return-Path/SPF** 加到 Cloudflare DNS(挂 `laifu` 子域下)。
   - ⚠️ **SPF 一个域只能一条 TXT**:子域上 Email Routing 已有 `include:_spf.mx.cloudflare.net`,
     与 Resend 的 include **合并成一条**(以 Resend 实际给的为准),别建两条。
   - 子域 MX 不动(留 Cloudflare 收信)。
3. Verify → 建 API Key → 填 gateway 的 `RESEND_API_KEY`。

## gateway 配置(三处 env)

| env | dev (`apps/gateway/.env.local`) | prod (bicep + KV) |
|---|---|---|
| `EMAIL_PROVIDER` | `resend` ✅已配 | `resend` |
| `EMAIL_DOMAIN` | `laifu.uncagedai.org` ✅已配 | `laifu.uncagedai.org` |
| `RESEND_API_KEY` | 待填 | KV `resend-api-key` |
| `POSTMARK_INBOUND_WEBHOOK_SECRET` | ✅已配(= Worker 的 INBOUND_WEBHOOK_SECRET) | KV `postmark-inbound-webhook-secret` |

prod:改 `infra/bicep/main.bicep` 三值 + `az keyvault secret set resend-api-key` + 重启 App Service。

## 端到端验证

- **入站**(Resend 没好也能先验):外部邮箱发到 `sunco@laifu.uncagedai.org` → gateway 落库。
  查:`GET /api/email/list`(容器 token)或本地库
  `select * from emails where direction='inbound' order by received_at desc limit 1;`
- **出站**:对该封 `in_reply_to_id` 调 `/api/email/send` → 应到达外部邮箱,且回信落回入站(闭环)。

## 线程一致性

Resend 的 send 只回自家 UUID(非 RFC Message-ID),故 `resend-provider` 自生成
`<uuid@laifu.uncagedai.org>` 作 Message-ID 经 headers 带出并入库,保证回信线程头一致。

## 入站 webhook 契约(Worker ↔ gateway,排错用)

- `POST {GATEWAY_URL}/api/email/inbound`,`Authorization: Basic base64("cf:" + INBOUND_WEBHOOK_SECRET)`
  (gateway 只校验冒号后的 pass);`Content-Type: application/json`。
- body 字段(Worker 定义,`src/index.ts`):`to`(信封收件人,定 handle)/`from_addr`/`to_addrs`/
  `cc_addrs`/`subject`/`message_id`/`in_reply_to`/`reference_ids`/`text`/`has_attachments`。
- gateway(`apps/gateway/src/api/email.ts`)鉴权后 `provider.parseInbound(body)` → 落库。
  返回:401 密钥错 / 400 解析失败 / 202 收件人 localpart 不在 `email_addresses`(丢弃) / 200 落库。
- 字段对应改动要 Worker 与 `resend-provider.parseInbound` 同步(`resend-provider.test.ts` 有断言兜底)。

## 入站附件(项目方前置)

- **新建 Blob 容器 `email-attachments`**(与云盘 `laifu-cloud` 分开):prod 由 bicep 建(已加资源);dev gateway 启动时 `createIfNotExists` 兜底,或手建一次。
- gateway 需 `EMAIL_ATTACHMENT_CONTAINER=email-attachments`(三处守则已加;dev `.env.local` 默认值即可)。
- gateway 系统身份已有 `Storage Blob Data Owner` → 能签 write/read SAS,无需额外授权。
- 建议给 `email-attachments` 容器挂 lifecycle 规则(按创建 N 天删),清理"上传成功但 commit 失败"的孤儿 blob。
- 附件 webhook 契约:prepare `{to_localpart, attachments:[{filename,content_type,size}]}` → `{recipient, uploads:[{idx,key,sas_url}]}`;commit body 增加 `attachment_keys:[{key,filename,content_type,size}]`。
- 下载:`GET /api/email/attachment?id=<email_id>&idx=<n>`(容器 token + email entitlement)→ 302 到 read-SAS。
