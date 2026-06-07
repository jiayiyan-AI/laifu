# Hermes 邮件能力设计

**日期**: 2026-06-07
**分支**: feat/cloud-drive-upload(后续应另起 feat/hermes-email)
**状态**: Draft, pending user review
**关联**: 复用 [2026-06-05-cloud-file-cli-design.md](./2026-06-05-cloud-file-cli-design.md) 的鉴权/存储/CLI 骨架
**前置依赖**: [2026-06-07-capability-system-generalization-design.md](./2026-06-07-capability-system-generalization-design.md)(子项 A)——邮件作为一个**能力条目**注册进通用能力系统,装备/移除走通用流程,不再写 bespoke 按钮。**先做完 A 再做 B。**

## 一、概要

给每个 Hermes 助手一个**专属邮箱地址**,让客户的业务对象(第三方)可以直接发邮件给助手,客户也可以把往来邮件转发进来。助手具备**收件箱读取**和**发信**两种能力,由客户在聊天里下指令驱动。

**痛点**: 客户的生意靠邮件做,把一封封往来邮件的上下文搬进微信再问助手太麻烦。让助手"直接待在邮件里"。

### 核心行为模型(来自 brainstorm)

> 邮件到达助手地址后**静默落库,什么都不做**。触发动作的是客户在聊天里下的指令(如"我转给你一封邮件,标题 X,去回复同意报价")。助手这时才去读那封邮件、按指令行动。

因此:
- **入站邮件 = 被动落库的数据**,不是触发器。独立于容器生命周期持久化(容器睡着/冷启动也不丢)。
- 助手需要两个能力:**读收件箱**(按指令去翻)+ **发信**(回复/新发,带正确线程头)。
- 发现机制是**拉取式**:客户问"有没有新邮件" → 助手 `email ls`。v1 不推通知、不做网页收件箱。

### 已定决策

| 维度 | 决定 |
|---|---|
| 用途 | 双向:既收第三方/转发来信,也代客户对外发信(真实业务往来) |
| 服务商 | **Postmark**(一家全包收发,入站自动解析,投递率最佳),封装在 adapter 后可换 |
| 地址方案 | **单域 + 每助手不同 localpart + catch-all**;成本随收发量涨,不随助手数涨 |
| localpart | **客户自选 handle**(如 `sunco-trade@<域名>`),开通时查重+校验 |
| 收到来信后 | **静默落库,不自动行动**,等聊天指令 |
| 网页收件箱 | **v1 不做**,只给 Agent(容器内 CLI 读写)。注意:邮件**仍有一张能力卡**(装备/移除),走子项 A 的通用流程;"不做"指的是不做收件箱**内容浏览**界面,不是不进能力管理 |
| 新邮件通知 | **完全静默**,不推通知(发现靠客户主动让助手 `email ls`) |
| 能力接入 | 在子项 A 的 catalog 注册一条 `{id:'email', removable:true, desktopApp:无}`;网关白名单加 `email`;**无桌面 app**(无收件箱 UI) |

### 不在本期(v2+)

- 网页端收件箱视图(浏览收到/发出的邮件;能力卡本身在本期,见上)
- 新邮件聊天通知(📩 推送)
- 客户自带域名(`assistant@客户公司.com`,每客户验证自己 DNS)
- 群发/营销式外联(Postmark 不允许,且需另设信誉策略)
- 收件箱垃圾邮件过滤/白名单(v1 依赖 Postmark spam score,全量落库)
- 发信限流 / 滥用检测(共享域名信誉保护,见 §九风险)

---

## 二、整体架构 & 数据流

```
【入站】业务对象发信 / 客户转发  ──→  Postmark
   → POST gateway /api/email/inbound   (Postmark 签名/Basic-Auth 校验, 不走容器 token)
   → 读收件人 localpart → 查 email_addresses 表 → user_id
   → 落库:
       · 元数据 + 纯文本正文(去引用) → Supabase emails 表 (direction='inbound')
       · 原始 .eml + html + 附件 → Blob (复用云盘 container, user_id/ 前缀隔离)
   → 完事。不通知、不触发容器。           ← 符合"什么都不做"

【客户在微信/网页下指令】"我转给你一封邮件,标题 X,去回复同意报价"
   → 走现有 chat 链路进 Hermes 容器

【助手行动】容器内 email CLI (照 cloud_file 模子, 容器 token 鉴权):
   · email ls [--q ...]        → GET  /api/email/list   只返该 user 的行
   · email read <id>           → GET  /api/email/get     正文+附件(SAS 下载)
   · email send --to ...       → POST /api/email/send    → Postmark API 发出
   · email reply <id> --body   → POST /api/email/send    带线程头, 收件人=原发件人
   ↑ 发出的信也写回 emails 表 (direction='outbound'), 线程历史完整
```

### 复用清单(几乎不发明新东西)

| 复用项 | 来自 | 说明 |
|---|---|---|
| 容器 CLI 鉴权 | cloud-file | `GATEWAY_BASE_URL` + `LAIFU_USER_TOKEN` + `containerAuth` 中间件,**容器 env 无需新增** |
| Blob 存储 | 云盘 | 原始邮件/附件进现有 container,`user_id/` 前缀隔离;SAS 下载复用 `buildReadBlobSas` |
| 能力开关 | `cloud` entitlement | 新增 `email` entitlement,同机制 gate |
| 容器内形态 | `skills/cloud/` | 新增 `docker/hermes/skills/email/`,Python `email` CLI + `SKILL.md` 并列 |

### 关键新增(云盘没有的)

1. `emails` 表 — 收件箱内容 + 线程关系(`Message-ID`/`In-Reply-To`/`References`),收发都存。
2. `email_addresses` 表 — localpart → user_id 路由表,开通时分配。
3. `POST /api/email/inbound` — 唯一不走容器 token 的端点,用 Postmark 签名校验防伪造投递。
4. `POST /api/email/send` — 发信,带线程头;落 outbound 行。
5. EmailProvider adapter — `parseInbound` + `send`,Postmark 实现,可换。

---

## 三、数据模型(Supabase)

### `email_addresses`(地址 → 用户 路由表)

| 列 | 类型 | 说明 |
|---|---|---|
| localpart | text PK | `@` 前那段,全局唯一(catch-all 路由键) |
| user_id | text FK | 归属用户 |
| display_name | text | 发信时 From 显示名(默认客户业务名,可改) |
| created_at | timestamptz | |

唯一约束: `localpart` 唯一(开通时查重)。

### `emails`(收件箱内容,收发都存)

| 列 | 类型 | 说明 |
|---|---|---|
| id | text PK | `eml_...` |
| user_id | text FK | 归属(隔离键) |
| direction | text | `inbound` / `outbound` |
| from_addr | text | |
| to_addrs | text[] | |
| cc_addrs | text[] | |
| subject | text | |
| message_id | text | 本邮件 Message-ID(出站由 Postmark 返回) |
| in_reply_to | text | 线程头 |
| references | text[] | 线程头 |
| body_text | text | 纯文本正文(入站取 Postmark 去引用后的 StrippedTextReply) |
| has_attachments | bool | |
| raw_blob_key | text | Blob 中原始 .eml 路径 `user_id/email/<id>/raw.eml` |
| attachment_keys | jsonb | `[{name, blob_key, size, content_type}]` |
| received_at | timestamptz | |

索引: `(user_id, received_at desc)`,`(user_id, message_id)`(回复时按 Message-ID 找线程)。

---

## 四、Gateway 端点

| 端点 | 鉴权 | 用途 |
|---|---|---|
| `POST /api/email/inbound` | Postmark 校验 | 接收 webhook,落库 |
| `GET /api/email/list` | containerAuth + email entitlement | 列该 user 邮件(newest first,`?q=` 搜主题/发件人,`?limit`) |
| `GET /api/email/get?id=` | containerAuth + email entitlement | 单封全文 + 附件 SAS 下载链接 |
| `POST /api/email/send` | containerAuth + email entitlement | 发信/回复,落 outbound 行 |

**inbound 校验**: Postmark inbound webhook 支持 URL 内嵌 Basic-Auth(`https://user:pass@gateway/...`)。用 KV 里的 `POSTMARK_INBOUND_WEBHOOK_SECRET` 校验,拒绝伪造投递。

**send 线程逻辑**: 带 `in_reply_to_id` 时,从 emails 表取原邮件的 `message_id` → 设 `In-Reply-To` + 追加 `References`,主题加 `Re:` 前缀,收件人默认=原 `from_addr`。From = `<localpart>@<域名>`(由 user_id 反查 email_addresses)。

---

## 五、容器内 CLI(`email`,照 cloud_file 模子)

单一可执行 `email`,argparse subparsers。Stdout 一行 JSON;退出码沿用 cloud_file 约定(0 成功 / 1 参数 / 2 鉴权 / 3 网络 / 4 其他)。

```bash
# 列收件箱(newest first), 可搜
email ls
email ls --q "报价" --limit 20

# 读一封: 打印头+正文, 附件下载到当前目录(或 -d 指定)
email read eml_abc123
email read eml_abc123 -d /home/hermes/work/

# 回复(自动线程头 + Re: + 收件人=原发件人)
email reply eml_abc123 --body "确认报价, 按此推进。" [--attach out/quote.pdf]

# 新发
email send --to bob@supplier.com --subject "询价" --body "..." [--cc ...] [--attach f]
```

附件: 入站附件 `email read` 下载到 cwd;出站 `--attach <本地路径>` 读取(可配合 cloud-file 先 get 下来),base64 传 Postmark(总大小 ≤ 10MB)。

`SKILL.md` 写明:**收到指令才操作;回复前先 `email read` 看懂原文;不确定收件人时回到聊天向客户确认**(尤其客户转发进来的邮件,真实收件人藏在转发正文里)。

---

## 六、Provider Adapter

```
interface EmailProvider {
  parseInbound(req): ParsedEmail        // from/to/subject/messageId/refs/text/attachments
  send(msg): Promise<{ messageId }>     // 实际投递, 返回 Message-ID
}
```

Postmark 实现:`parseInbound` 直接吃 Postmark 解析好的 JSON(含 `StrippedTextReply`、`Attachments`);`send` 调 Postmark `/email` API,自定义 Header 带线程信息。换 Mailgun/SES 只改这一个文件。

---

## 七、Provisioning(开通流程)

开通带 `email` entitlement 的助手时,在现有 provisioning 流程加一步:
1. 客户选 handle → 校验格式(`[a-z0-9-]`)+ 查重 `email_addresses`。
2. 写入 `email_addresses (localpart, user_id, display_name)`。
3. **无需每用户 DNS / 无需在 Postmark 建任何东西** —— catch-all 是域级一次性配置。

---

## 八、一次性基建(infra,文档化,非代码)

1. 注册域名(如 `lingxi-mail.xxx`),约 ¥70/年。
2. Postmark 账号:验证**发信域名**(DKIM + Return-Path,一次覆盖所有 localpart);配置**入站域名**(MX 指向 Postmark inbound);设入站 webhook URL → gateway `/api/email/inbound`(带 Basic-Auth)。
3. DNS:MX / SPF / DKIM / DMARC。
4. 记入 `docs/deployment-azure-first-run.md`(无法代码化的一次性坑)。

### env 三处同步(守则)

新增 env 同步出现在 `apps/gateway/.env.example` + `apps/gateway/src/config.ts` + `infra/bicep/main.bicep`:

| env | 值 | 敏感 |
|---|---|---|
| `POSTMARK_SERVER_TOKEN` | 发信 token | KV |
| `POSTMARK_INBOUND_WEBHOOK_SECRET` | 入站 Basic-Auth | KV |
| `EMAIL_DOMAIN` | 助手地址域名 | 否 |
| `EMAIL_FROM_DEFAULT_NAME` | From 缺省显示名 | 否 |

容器侧:**无新增 env**(复用 `GATEWAY_BASE_URL` + `LAIFU_USER_TOKEN`)。

---

## 九、风险 / 已知取舍

- **共享域名信誉**: 所有助手共用一个发信域名 = 共用信誉。某助手被滥用 → 整域被拉黑,全员受损。v1 接受,v2 加发信限流 / 滥用检测。
- **静默 + 无网页 + 无通知 → 发现全靠拉取**: 第三方直接来信若客户不知情,只能等客户主动让助手 `email ls` 才发现。这是 v1 明确取舍;v2 的通知/网页收件箱解决。客户**转发**进来的信不受影响(他本来就知道)。
- **转发邮件的真实收件人**: 客户转发的信,原收件人藏在正文里,助手回复时需读出来或让客户在指令里指明。SKILL.md 要求不确定就回聊天确认。
- **开放收件箱 = 收垃圾**: 任意人可发到助手地址,垃圾全量落库。v1 靠 Postmark spam score 标记,客户/助手自行忽略;v2 加白名单。
- **附件大小**: Postmark 单封 ≤ 10MB(与云盘上传限一致)。超限的附件入站会被截断/拒绝,需在 inbound handler 记录并跳过。
- **catalog ↔ 后端白名单漂移**(来自子项 A 最终评审): 前端 `capabilities.tsx` 的能力 id、`api` feature 字符串、gateway `ALLOWED_FEATURES` 三处必须一致。加 `email` 时若漏掉 gateway 白名单会静默 404。本期落 email 时一并:要么从 `@lingxi/shared` 导出能力 id 列表派生白名单,要么加一个契约测试断言三处同步。

---

## 十、实现顺序(粗粒度)

> **前置:子项 A(能力系统通用化)已完成。**

1. 基建一次性配置(域名 + Postmark + DNS + webhook),先能收到 webhook。
2. Supabase migration:`email_addresses` + `emails` 表。
3. Gateway:EmailProvider adapter(Postmark)+ `/api/email/inbound` 落库。
4. Gateway:`/api/email/list|get|send` + 线程逻辑;`entitlements` 白名单加 `email`。
5. 容器:`skills/email/` CLI + SKILL.md(照 cloud_file 抄)。
6. Provisioning:开通分配 handle(客户自选,查重)。
7. Web:在 A 的 catalog 注册 `email` 能力卡(`lib/icons` 补 mail 图标),装备/移除走通用组件——**无桌面 app**。
8. 端到端:装备能力 → 发一封 → webhook 落库 → `email ls/read` → `email reply` → 对方收到且线程正确。
