# 入站邮件附件落 Blob + 可下载 设计

**日期**: 2026-06-12
**分支**: 建议另起 `feat/email-inbound-attachments`(基于 main)
**状态**: Draft, pending user review
**关联**: 复用 [2026-06-04-cloud-drive-upload-design.md](./2026-06-04-cloud-drive-upload-design.md) 的 Blob 上传 / UDK + SAS 下载骨架;接续邮件 MVP(PR #11,入站 CF Email Routing + 出站 Resend)
**前置**: 邮件 MVP 已落地(`apps/gateway/src/lib/email/`、`infra/cloudflare-email-worker/`、`emails` 表)

## 一、概要

给**入站邮件**补上附件能力:对方发到 `<handle>@laifu.uncagedai.org` 的附件,落到 Azure Blob,且助手能下载。当前实现只记一个 `has_attachments` 布尔,附件内容被 CF Worker 直接丢弃。

**本次范围**:入站附件落 Blob + 可下载(gateway 端点签 SAS)。
**不在本次**:出站带附件、容器 `email` CLI 的附件交互、raw .eml 留存。

## 二、关键约束(决定了方案)

- **CF Email Routing 入站总大小 ≤ 25 MiB**(头+正文+所有附件,MIME 编码后)。附件 base64 膨胀 ~37% → **实际可收附件总量 ≈ ≤18 MiB**。大于此的邮件在边缘被拒,Worker 不触发。→ "大附件"在邮件这条路是伪命题;大文件走 web 云盘上传,不走邮件。
- **CF Worker 内存 128 MB,且"每 isolate 并发共享"**。同一 isolate 上并发的多封邮件内存累加 → 不能在 Worker 里做 base64+JSON 多份拷贝(否则突发并发会连环 OOM)。
- **附件字节只在 `email()` handler 执行期可得**(`message.raw` 流),CF 不持久化入站邮件、无事后可拉的 URL → 字节必须在 handler 内送走。

## 三、方案选择:B(Worker 直传 Azure Blob)

三方案对比(详见 brainstorm 记录):

| | A base64→gateway | **B Worker 直传 Azure(SAS)** | C2 R2 暂存+异步 |
|---|---|---|---|
| Worker 内存峰值 | raw+解析+base64+json,顶满逼近 128MB,有 OOM 风险 | raw+解析 ≈ 安全,无 base64/json 拷贝 | 流式,最低 |
| 新基建 | 无 | **无(全 Azure)** | +R2 桶+S3 凭据+生命周期+网关 MIME 解析+跨云拷 |
| 复用现有 | 多 | **最多(云盘那套 Blob+SAS)** | 少 |
| 复杂度 | 低 | 中 | 高 |

**选 B**:内存安全(并发场景关键)、全 Azure 不引第二朵云、最大复用云盘机制。可靠性靠失败 `message.setReject()` 让发件方 MTA 重投,不需 R2 暂存。C2(SES→S3→异步处理 工业模式)留作高量级/强审计/要 raw 留存时再上。

## 四、数据流(两阶段:prepare → 上传 → commit)

```
对方发信(≤25MiB) → CF Email Routing → Worker(postal-mime 解析)

  ── 有附件 ──
  1. prepare:  Worker → POST /api/email/inbound/prepare
                 body: { to_localpart, attachments: [{ filename, content_type, size }] }
               gateway 查收件人归属(findUserByLocalpart,仅 localpart→user,**不解析邮件**):
                 - 未知收件人 → { recipient: "unknown" } → Worker 丢弃(不上传、不 commit)
                 - 已知 → 每附件生成独立随机 attId + blob key + 短期 write-SAS(5min, 仅写)
                          → { recipient: "ok", uploads: [{ idx, key, sas_url }] }   ← 不含 email_id
  2. 上传:     Worker 对每个附件 PUT sas_url (Azure Blob, x-ms-blob-type: BlockBlob, Content-Type)
                 传完即释放该附件引用(控制内存)
  3. commit:   Worker → POST /api/email/inbound
                 body: { ...解析后的邮件中立结构, attachment_keys: [...] }   ← Worker 带着 prepare 拿到的 keys
               gateway 插入 emails 行(email_id 仍在此处自生成, attachment_keys 落库)

  ── 无附件 ──
  直接 POST /api/email/inbound(现有流程, attachment_keys=[]), 向后兼容

  ── 任一步失败 ──
  Worker message.setReject("temporary failure") → 发件方 MTA 按 SMTP 重投(不丢信)
```

**解析职责(钉死)**:邮件 MIME 解析**全程在 Worker**(postal-mime),与现有 MVP 一致;gateway **从不解析邮件**,只做"localpart→user"查找、签 SAS、落库。(对照:C2 方案才把解析放 gateway,本设计是 B,不采用。)

未知收件人的处理:prepare 已能判未知 → 让 Worker **直接丢弃且不上传**(避免给不存在的 handle 占用存储)。gateway 在 prepare 与 commit 两处都记 `email.inbound.drop / unknown_recipient` 日志(commit 侧日志已在 PR #11 加)。

## 五、组件与接口

### 5.1 存储:专用容器 + 与 uid 解耦的 key
- **专用 Blob 容器** `email-attachments`(与云盘 `laifu-cloud` 分开)——关注点分离;生命周期/GC 规则可直接挂整个容器。
- 容器内 key:
  ```
  ${localpart}/${attId}-${safe_filename}
  ```
  - **`localpart` = 收件人 handle(如 `sunco`)做一级目录**,纯为**运维/门户按 handle 浏览**方便(应用查询走 DB,不靠此)。用 localpart 而非完整邮箱(域名固定、是噪音);prepare 已解析出 localpart,防御性去掉路径分隔符。
  - **`attId` = 每个附件独立的随机 id(ULID/uuid),prepare 阶段 gateway 生成**。**不依赖 email_id、不依赖 userId(租户 UUID)**。
  - 注:`localpart` 是人类可读 handle、非租户 UUID;隔离仍在 DB+gateway 层(下载按 `email.user_id` 校验),路径不承担隔离。handle 改名后旧附件留在旧目录(DB 里 key 是真相、照样可下)。
  - `safe_filename`:保留原名供可读 + 作下载 content-disposition;清洗规则=去路径分隔符(`/ \`)+ 控制字符,限长(≤200),保留扩展名;为空则回退 `attachment`。
- **email ↔ 附件的唯一关联 = `emails.attachment_keys` 数组**(行里记下这些 key)。无需把关系编码进 blob 路径。
- **隔离/鉴权在 DB + gateway 层**:下载端点按 `email_id` 查 `emails` 行、校验 `email.user_id == req.user_id` 通过后,从该行的 `attachment_keys` 取 key 签 read-SAS。附件**不**经目录级 SAS 暴露;storage 路径不承担隔离/归属职责。
- key 由 gateway 在 prepare 阶段生成,Worker 只 PUT 到返回的 SAS → 路径细节对 Worker 零负担。

### 5.2 `attachment_keys`(jsonb,`emails` 表已有该列)
```json
[
  { "key": "01JABCXYZ...-quote.pdf", "filename": "quote.pdf",
    "content_type": "application/pdf", "size": 183422 }
]
```
（`key` 是 `email-attachments` 容器内的相对路径,不含 userId。）
`has_attachments` 仍按有无附件取布尔。

### 5.3 gateway 新端点 / 改动

**新 `POST /api/email/inbound/prepare`**(Basic-Auth,同 `inboundWebhookSecret`)
- in: `{ to_localpart, attachments: [{ filename, content_type, size }] }`
- 行为:`findUserByLocalpart` → 未知回 `{recipient:"unknown"}`(+ warn 日志);已知则**逐附件生成独立随机 `attId` + 算 key + 用 `udkCache` + sas-builder 签 write-SAS(TTL 5min,写权限,限定到该 blob)** → 回 `{recipient:"ok", uploads:[{idx,key,sas_url}]}`。
- **不涉及 email_id、不写库**(只发 keys + SAS)。prepare 与 commit 的关联靠 Worker 把 keys 带到 commit,不靠 email_id。

**改 `POST /api/email/inbound`**(commit)
- 接受可选 `attachment_keys`(Worker 从 prepare 拿到的 key + 它本地知道的 filename/type/size 拼成)。
- `email-dao.insertInbound` **id 逻辑不变**(仍在 insert 时自生成 `eml_*`),只多写 `attachment_keys` 列。**不需要传入 id、不需要 `newEmailId`。**

**新 `GET /api/email/attachment?id=<email_id>&idx=<n>`**(containerAuth + email entitlement)
- 行为:按 id 取 email,校验 `email.user_id == req.user_id` → 取 `attachment_keys[idx]` → 用 udkCache + sas-builder 签 **read-SAS**(content-disposition=`attachment; filename*=...`,复用 cloud download 同款)→ 回 `{ url }`(或 302)。

**email router deps 增加**:`blobServiceClient`、`udkCache`、SAS TTL 配置,与 cloud.ts 同源注入;**容器名用新 `config.email.attachmentContainer`(默认 `email-attachments`)**,不复用 `config.cloud.container`。

**新容器 provisioning**:`email-attachments` 容器需建出来——bicep 在 storage account 下加一个 container 资源(与现有 `laifu-cloud` 并列);dev 首次用前 gateway `containerClient.createIfNotExists()` 兜底或手建一次。`EMAIL_ATTACHMENT_CONTAINER` 走三处守则(.env.example / config.ts / bicep)。

### 5.4 Worker 改动(`infra/cloudflare-email-worker/src/index.ts`)
- 解析后:有附件 → prepare → 逐个 PUT → commit;无附件 → 直接 commit。
- PUT:`fetch(sas_url, { method:"PUT", headers:{ "x-ms-blob-type":"BlockBlob", "Content-Type": ct }, body: arrayBuffer })`。
- prepare 的 URL = `${GATEWAY_URL}/api/email/inbound/prepare`,Basic-Auth 同 inbound。
- 任一步非 2xx / 抛错 → `message.setReject("temporary failure, retry later")`。

### 5.5 容器 CLI `email`(**不在本次**,见 §八)
本次只打通 gateway + Worker(落库 + 可经 `/api/email/attachment` 下载)。容器 `email read` 展示附件/下载留到下一步。

## 六、错误处理 / 一致性 / 安全

- **失败重投**:prepare/PUT/commit 任一失败 → `setReject` → SMTP 重投(B 的可靠性来源)。
- **孤儿 blob**:上传成功但 commit 失败 → 留下无 DB 行的 blob。
  - ⚠️ **不能用"整桶按龄删"的 lifecycle 规则**——附件是**长期保留**的(助手要能下载很久以前邮件的附件),按龄删会误删合法附件 = 数据丢失。
  - 正确做法是**引用感知 GC**:对照 `emails.attachment_keys`,删掉"容器里有、但没有任何 emails 行引用"的 blob。
  - 孤儿只在"上传成功但 commit 失败"时产生,频率极低 → **本次不做 GC**(列为 follow-up),先接受少量孤儿。
- **重投去重**:重试生成新 email_id → 可能重复入库。MVP:commit 时按 `message_id` upsert/查重(`emails.message_id` 已存)→ 同 Message-ID 不重复插、且不重复占存储。
- **SAS 范围**:write-SAS 限定到**单个 blob key**、写权限、TTL 5min,最小权限。read-SAS 限定单 blob、读、短 TTL(同云盘 download)。
- **大小**:信任 25MiB 边缘封顶;prepare 可选校验单附件/总和上限(防异常 manifest),超限拒绝。
- **内存/并发**:Worker 每封峰值 = raw + 解析(无 base64/json 拷贝),附件 PUT 后释放;并发共享 128MB/isolate 下安全。

## 七、测试

- **gateway 单测**:
  - prepare:已知收件人返回 uploads(keys + SAS 形态),不含 email_id;未知返回 unknown + warn。
  - inbound(commit):带 attachment_keys 正确落库(email_id insert 时自生成);无附件兼容旧路径。
  - attachment 下载:属主校验(他人 email 403/404)、签出 read-SAS、content-disposition 含 filename。
  - SAS 签名 mock blobServiceClient/udkCache(同 cloud 测试方式)。
- **Worker**:`wrangler dev` + 本地 gateway,构造带附件的测试 email 事件,验证 prepare→PUT→commit + 失败 setReject 路径。
- **端到端**:从 Gmail 发带 PDF 附件的邮件到 `sunco@laifu.uncagedai.org` → emails 行 `has_attachments=true` + `attachment_keys` 有项 → `/api/email/attachment` 能下到原文件。

## 八、不在本期(YAGNI)

- 出站带附件(`SendInput.attachments` + resend-provider)。
- 容器 `email` CLI 的附件交互(列附件 / 下载),见 §5.5。
- raw .eml 留存(Blob)。
- C2(R2 暂存/异步处理)——高量级/强审计再评估。
- 内联图片(cid:)特殊处理——按普通附件存,前端渲染后续。

## 九、待确认 / 风险

1. **write-SAS 由 gateway 现有 UDK 机制签**:gateway 系统身份已有 `Storage Blob Data Owner`(签 user-delegation key,云盘下载在用)。需确认同一机制能签**写**权限 SAS(应可:UDK + `racwd` 中的 `w`)。
2. **两阶段 vs 一致性**:prepare/commit 之间的孤儿与重复,靠 lifecycle + Message-ID 去重兜底,接受最终一致(非强事务)。
3. **未知收件人**:已定为"Worker 直接丢弃、不上传不 commit",gateway prepare 侧记 warn 日志(§四)。
