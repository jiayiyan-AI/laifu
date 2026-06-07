---
name: email
description: 助手的邮件收发能力(读收件箱/发信/回信)。当用户说"看看有没有新邮件/帮我回那封报价邮件/给 X 发封邮件"→ 用 email CLI。收到邮件不会主动通知,需用户让你 ls 才发现。
version: 0.1.0
platforms: [linux]
metadata:
  hermes:
    tags: [email, mail, inbox, laifu]
---

# email

助手的邮件收发工具,四个子命令:`ls`(列收件箱)、`read`(读一封)、`send`(新发)、`reply`(回信)。

## 何时使用

- "有没有新邮件""看下收件箱""客户回复了吗" → `email ls`(可加 `--q` 搜)
- "把那封报价邮件读给我""第二封讲什么" → 先 `email ls` 拿 id,再 `email read <id>`
- "回复那封邮件,说同意报价" → 先 `email read <id>` 看懂原文,再 `email reply <id> --body "..."`
- "给 bob@supplier.com 发封询价" → `email send --to bob@supplier.com --subject "询价" --body "..."`

## 用法

```bash
# 列收件箱(newest first), 可搜可限量
email ls
email ls --q "报价" --limit 20

# 读一封(打印头 + 正文 + 线程头)
email read eml_abc123

# 回信(自动接线程头 + 收件人默认=原发件人 + 主题自动 Re:)
email reply eml_abc123 --body "确认报价,按此推进。"
email reply eml_abc123 --body "..." --to other@x.com --subject "自定义主题"

# 新发
email send --to bob@supplier.com --subject "询价" --body "..."
email send --to a@x.com --to b@y.com --cc c@z.com --subject "..." --body "..."
```

## 重要约束(必读)

- **收到指令才操作**:邮件到达只是静默落库,不会触发你。用户在聊天里让你做时才动。
- **回复前先 `email read` 看懂原文**:别凭主题猜内容。
- **不确定收件人就回聊天问**:尤其用户**转发**进来的邮件,真实收件人藏在转发正文里,`reply` 默认回的是"转发者"而非原始对方。拿不准时让用户明确收件人。
- 本期**不支持附件**(收发都不带附件)。
- `--body` 是纯文本。

## 输出与退出码

stdout 一行 JSON。成功时:
- `ls`:`{"ok":true,"emails":[{id,direction,from_addr,to_addrs,subject,has_attachments,received_at}]}`
- `read`:`{"ok":true,"email":{...,cc_addrs,message_id,in_reply_to,reference_ids,body_text}}`
- `send`/`reply`:`{"ok":true,"id":"eml_...","message_id":"<...>"}`

失败时:`{"ok":false,"error":"<message>"}`

退出码:0=成功,1=参数错误(如 send 缺 --to),2=鉴权失败,3=网络/gateway 非 2xx(含 read 找不到该邮件、reply 的 in_reply_to_id 不存在、send 缺收件人被网关拒),4=其他。
