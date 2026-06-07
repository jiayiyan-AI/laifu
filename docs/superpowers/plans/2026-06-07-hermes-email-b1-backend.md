# Hermes 邮件能力 B1 — 后端数据面 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把邮件能力的后端数据面做完并在本地用 fake provider 跑通:收件落库 + 列/读/发,真实 Postmark 仅最后换 env 接上。

**Architecture:** `EmailProvider` adapter(`fake` 给 dev,`postmark` 给 prod,按 `EMAIL_PROVIDER` env 切,业务码不分支)封装收发;`/api/email/inbound` 走 Basic-Auth 把来信解析后经 `email-dao` 落 Supabase `emails` 表;`/api/email/list|get|send` 走 containerAuth + `email` entitlement 给容器 CLI 用;发信也落 outbound 行,回复带线程头。

**Tech Stack:** Node 22 + TypeScript(ESM,import 带 `.js`)、Express、Supabase、vitest + supertest。

**对应 spec:** `docs/superpowers/specs/2026-06-07-hermes-email-capability-design.md`(§二~§六)

**B 系列拆分:** 本计划是 **B1(后端数据面)**。后续 **B2**(容器 `email` CLI + skill)、**B3**(provisioning 分配 handle + web catalog 注册 + 防漂移)另开计划,同分支 `feat/capability-system`,最后 A+B 一起合。

**本计划不含(明确推迟):**
- 附件 + 原始 `.eml` 的 Blob 存取(`emails.raw_blob_key`/`attachment_keys` 列本期建好但留空;接 Blob 在 B 系列后续任务)。
- 容器 CLI / SKILL.md(B2)。
- provisioning 分配 handle / web 能力卡 / 网关 `email` 白名单(B3)。本计划里 `/api/email/*` 的 entitlement gate 用现有 `email` entitlement 判定即可;给测试用户手动插一行 `user_entitlements(feature='email')` 就能测。
- `infra/bicep/main.bicep` 的 prod appSettings(随 B3 或部署时补;本期只动 `config.ts` + `.env.example`,dev 用 fake 不需要 Postmark 凭据)。

---

## 文件结构

**新建:**
- `infra/supabase/migrations/0007_email.sql` — `email_addresses` + `emails` 表。
- `apps/gateway/src/lib/email/provider.ts` — `EmailProvider` 接口 + `ParsedEmail`/`SendInput`/`SendResult` 类型。
- `apps/gateway/src/lib/email/fake-provider.ts` — dev fake(parseInbound 吃简单 JSON;send 不真发,返回合成 messageId)。
- `apps/gateway/src/lib/email/postmark-provider.ts` — Postmark 实现。
- `apps/gateway/src/lib/email/index.ts` — `getEmailProvider(cfg)` 工厂,按 `provider` 选 fake/postmark。
- `apps/gateway/src/db/email-dao.ts` — `EmailDao`:`findUserByLocalpart` / `getAddress` / `insertInbound` / `insertOutbound` / `list` / `get`。
- `apps/gateway/src/api/email.ts` — router:`inbound`(Basic-Auth)+ `list`/`get`/`send`(containerAuth + email entitlement)。
- 测试:`apps/gateway/test/lib/email/fake-provider.test.ts`、`postmark-provider.test.ts`、`apps/gateway/test/db/email-dao.test.ts`、`apps/gateway/test/api/email.test.ts`。

**修改:**
- `apps/gateway/src/config.ts` — 加 `email` 配置块。
- `apps/gateway/.env.example` — 加邮件 env。
- `apps/gateway/src/index.ts` — 构造 provider + 挂 email router。

**测试命令:**
- 单文件:`pnpm --filter @lingxi/gateway exec vitest run <相对路径>`
- 全 gateway:`pnpm --filter @lingxi/gateway test`
- 类型检查:`pnpm --filter @lingxi/gateway lint`

---

## Task 1: Supabase migration — email_addresses + emails

**Files:**
- Create: `infra/supabase/migrations/0007_email.sql`

- [ ] **Step 1: 写迁移**

创建 `infra/supabase/migrations/0007_email.sql`:

```sql
-- B1: 邮件能力数据面
-- spec: docs/superpowers/specs/2026-06-07-hermes-email-capability-design.md §三
--
-- email_addresses: localpart → user 路由表 (catch-all 入站按 localpart 找 user)
-- emails: 收发邮件内容 (direction 区分 inbound/outbound), 线程关系靠 message_id/in_reply_to/references
-- 注: 附件/原始 eml 的 blob key 列本期建好留空, Blob 存取在后续任务接。

create table email_addresses (
  localpart    text primary key,                          -- @ 前那段, 全局唯一 (catch-all 路由键)
  user_id      uuid not null references users(id) on delete cascade,
  display_name text,                                       -- 发信 From 显示名
  created_at   timestamptz not null default now()
);

create index email_addresses_user on email_addresses (user_id);

create table emails (
  id               text primary key,                      -- 'eml_...'
  user_id          uuid not null references users(id) on delete cascade,
  direction        text not null check (direction in ('inbound','outbound')),
  from_addr        text not null,
  to_addrs         text[] not null default '{}',
  cc_addrs         text[] not null default '{}',
  subject          text not null default '',
  message_id       text,                                  -- 本邮件 Message-ID
  in_reply_to      text,                                  -- 线程头
  reference_ids    text[] not null default '{}',          -- References 头 (列名避开 SQL 关键字 references)
  body_text        text not null default '',              -- 纯文本正文 (入站取去引用后的 reply)
  has_attachments  boolean not null default false,
  raw_blob_key     text,                                  -- 预留: 原始 .eml blob 路径
  attachment_keys  jsonb not null default '[]',           -- 预留: [{name, blob_key, size, content_type}]
  received_at      timestamptz not null default now()
);

create index emails_user_received on emails (user_id, received_at desc);
create index emails_user_message on emails (user_id, message_id);
```

- [ ] **Step 2: 应用到本地 supabase**

Run: `pnpm --filter @lingxi/gateway exec supabase db push` 或 `supabase migration up`(若仓库用 `supabase` CLI;如果本地 supabase 是 `supabase start`,执行 `supabase db reset` 会重放所有迁移——**会清数据**,dev 可接受;更稳妥用 `psql "$SUPABASE_DB_URL" -f infra/supabase/migrations/0007_email.sql` 单独跑这一个)。
Expected: 两表创建成功,无报错。验证:
`psql "$SUPABASE_DB_URL" -c "\d emails"` 能看到表结构。

> 注:`SUPABASE_DB_URL` 在 `apps/gateway/.env.local`;本地 supabase 默认 `postgresql://postgres:postgres@127.0.0.1:54422/postgres`(端口看 `supabase status`)。若不确定迁移工具,优先单文件 psql 跑,避免 db reset 清掉现有 dev 数据。

- [ ] **Step 3: Commit**

```bash
git add infra/supabase/migrations/0007_email.sql
git commit -m "$(cat <<'EOF'
feat(email): migration 0007 — email_addresses + emails 表

email_addresses: localpart→user 路由; emails: 收发内容+线程头(direction 区分)。
附件/raw eml 的 blob 列预留留空, 后续任务接 Blob。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: 共享契约类型

**Files:**
- Modify: `packages/shared/src/contracts.ts`(在文件末尾追加)
- Test: 无(纯类型)

- [ ] **Step 1: 追加邮件契约**

在 `packages/shared/src/contracts.ts` 末尾追加:

```typescript
// === 邮件能力 (B1) ===

/** provider 把入站邮件解析成的中立结构 */
export interface ParsedInboundEmail {
  to_localpart: string;        // 收件人 @ 前那段, 路由键
  from_addr: string;
  to_addrs: string[];
  cc_addrs: string[];
  subject: string;
  message_id: string | null;
  in_reply_to: string | null;
  reference_ids: string[];
  body_text: string;           // 去引用后的纯文本
  has_attachments: boolean;
}

export type EmailDirection = 'inbound' | 'outbound';

/** 列表项 (不含正文, 列表轻量) */
export interface EmailListItem {
  id: string;
  direction: EmailDirection;
  from_addr: string;
  to_addrs: string[];
  subject: string;
  has_attachments: boolean;
  received_at: string;
}

export interface EmailListResponse {
  emails: EmailListItem[];
}

/** 单封详情 (含正文 + 线程头) */
export interface EmailDetail extends EmailListItem {
  cc_addrs: string[];
  message_id: string | null;
  in_reply_to: string | null;
  reference_ids: string[];
  body_text: string;
}

export interface EmailDetailResponse {
  email: EmailDetail;
}

/** 容器 CLI 发信请求 */
export interface EmailSendRequest {
  to: string[];
  cc?: string[];
  subject: string;
  body_text: string;
  in_reply_to_id?: string;     // 给定则按该邮件接线程 + 收件人默认=原发件人
}

export interface EmailSendResponse {
  ok: true;
  id: string;                  // 落库的 outbound 邮件 id
  message_id: string;          // provider 返回的 Message-ID
}
```

- [ ] **Step 2: build shared(下游 gateway 引用要先 build)**

Run: `pnpm --filter @lingxi/shared build`
Expected: 成功,无类型错误。

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/contracts.ts
git commit -m "$(cat <<'EOF'
feat(email): shared 契约类型 (ParsedInboundEmail / EmailList* / EmailSend*)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: config.ts 邮件配置块 + .env.example

**Files:**
- Modify: `apps/gateway/src/config.ts`
- Modify: `apps/gateway/.env.example`

- [ ] **Step 1: config 加 email 块**

在 `apps/gateway/src/config.ts` 的 `config` 对象里,`cloud: {...}` 块**之后**追加:

```typescript
  email: {
    // 'fake' (dev, 不真收发) | 'postmark' (prod)。业务码不分支, 全靠 provider adapter。
    provider: (process.env['EMAIL_PROVIDER'] ?? 'fake') as 'fake' | 'postmark',
    // 助手邮箱地址的域名, 如 'mail.lingxi.xxx'。dev fake 下随便填。
    domain: process.env['EMAIL_DOMAIN'] ?? 'mail.localhost',
    // 发信 From 缺省显示名
    fromDefaultName: process.env['EMAIL_FROM_DEFAULT_NAME'] ?? '灵犀助理',
    // 入站 webhook 的 Basic-Auth 共享密钥 (Postmark inbound URL 内嵌 user:pass 里的 pass)
    inboundWebhookSecret: process.env['POSTMARK_INBOUND_WEBHOOK_SECRET'] ?? 'dev-inbound-secret',
    // Postmark 发信 server token (仅 provider=postmark 用)
    postmarkServerToken: process.env['POSTMARK_SERVER_TOKEN'] ?? '',
  },
```

- [ ] **Step 2: .env.example 加注释项**

在 `apps/gateway/.env.example` 末尾追加:

```bash
# === 邮件能力 (B 系列) ===
# dev 用 fake (本地不真收发); prod 设 postmark
EMAIL_PROVIDER=fake
# 助手邮箱域名 (fake 下随意)
EMAIL_DOMAIN=mail.localhost
EMAIL_FROM_DEFAULT_NAME=灵犀助理
# 入站 webhook Basic-Auth 密钥 (Postmark inbound URL 内嵌)
POSTMARK_INBOUND_WEBHOOK_SECRET=dev-inbound-secret
# Postmark 发信 token (仅 prod)
POSTMARK_SERVER_TOKEN=
```

- [ ] **Step 3: 类型检查**

Run: `pnpm --filter @lingxi/gateway lint`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/src/config.ts apps/gateway/.env.example
git commit -m "$(cat <<'EOF'
feat(email): config.email 块 + .env.example (provider/domain/secret)

EMAIL_PROVIDER 默认 fake; bicep prod appSettings 随 B3/部署补。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: EmailProvider 接口 + 类型

**Files:**
- Create: `apps/gateway/src/lib/email/provider.ts`

- [ ] **Step 1: 写接口(无测试 — 纯类型/接口)**

创建 `apps/gateway/src/lib/email/provider.ts`:

```typescript
import type { ParsedInboundEmail } from '@lingxi/shared';

/** 发信入参 (gateway 已算好 from / 线程头, provider 只管投递) */
export interface SendInput {
  from_addr: string;        // '<localpart>@<domain>'
  from_name: string;        // 显示名
  to: string[];
  cc: string[];
  subject: string;
  body_text: string;
  in_reply_to?: string;     // 原邮件 Message-ID (线程头)
  reference_ids?: string[]; // References 链
}

export interface SendResult {
  message_id: string;       // 投递后的 Message-ID (落 outbound 行用)
}

/**
 * 邮件服务商适配器。fake (dev) / postmark (prod) 各实现一份, 业务码只依赖此接口。
 */
export interface EmailProvider {
  /**
   * 把入站 webhook 的 request body 解析成中立结构。
   * 解析不出有效收件人时抛错 (路由会回 400)。
   */
  parseInbound(body: unknown): ParsedInboundEmail;
  /** 实际投递, 返回 Message-ID。 */
  send(input: SendInput): Promise<SendResult>;
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm --filter @lingxi/gateway lint`
Expected: 无错误。

- [ ] **Step 3: (不单独 commit, 与 Task 5/6/7 一并提交 provider 层)**

---

## Task 5: Fake provider (dev)

**Files:**
- Create: `apps/gateway/src/lib/email/fake-provider.ts`
- Test: `apps/gateway/test/lib/email/fake-provider.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/gateway/test/lib/email/fake-provider.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { makeFakeProvider } from '../../../src/lib/email/fake-provider.js';

const provider = makeFakeProvider();

describe('fakeProvider.parseInbound', () => {
  it('从简单 JSON 解析出中立结构', () => {
    const parsed = provider.parseInbound({
      to: 'sunco@mail.localhost',
      from: 'bob@supplier.com',
      subject: '报价',
      text: '请确认',
      message_id: '<m1@supplier.com>',
    });
    expect(parsed.to_localpart).toBe('sunco');
    expect(parsed.from_addr).toBe('bob@supplier.com');
    expect(parsed.subject).toBe('报价');
    expect(parsed.body_text).toBe('请确认');
    expect(parsed.message_id).toBe('<m1@supplier.com>');
    expect(parsed.to_addrs).toEqual(['sunco@mail.localhost']);
  });

  it('缺收件人 → 抛错', () => {
    expect(() => provider.parseInbound({ from: 'a@b.com' })).toThrow();
  });
});

describe('fakeProvider.send', () => {
  it('返回合成 message_id, 不真发', async () => {
    const r = await provider.send({
      from_addr: 'sunco@mail.localhost', from_name: '灵犀',
      to: ['bob@supplier.com'], cc: [], subject: 'Re: 报价', body_text: '同意',
    });
    expect(r.message_id).toMatch(/@mail\.localhost>$/);
  });
});
```

- [ ] **Step 2: 跑测试看失败**

Run: `pnpm --filter @lingxi/gateway exec vitest run test/lib/email/fake-provider.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现 fake provider**

创建 `apps/gateway/src/lib/email/fake-provider.ts`:

```typescript
import type { ParsedInboundEmail } from '@lingxi/shared';
import type { EmailProvider, SendInput, SendResult } from './provider.js';

const localpartOf = (addr: string): string => addr.split('@')[0]!.trim().toLowerCase();
const asArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : [];

/**
 * Dev fake: 入站吃一个简单 JSON {to, from, subject, text, ...}; 出站不真发,
 * 合成一个 Message-ID 返回 (由 send 调用方落 outbound 行)。
 * 让本地不依赖 Postmark/域名/DNS 就能跑通整条收发链路。
 */
export const makeFakeProvider = (): EmailProvider => ({
  parseInbound(body: unknown): ParsedInboundEmail {
    const b = (body ?? {}) as Record<string, unknown>;
    const to = typeof b['to'] === 'string' ? (b['to'] as string) : asArray(b['to'])[0] ?? '';
    if (!to || !to.includes('@')) throw new Error('fake inbound: missing/invalid "to"');
    const refs = asArray(b['reference_ids'] ?? b['references']);
    return {
      to_localpart: localpartOf(to),
      from_addr: String(b['from'] ?? ''),
      to_addrs: asArray(b['to']).length ? asArray(b['to']) : [to],
      cc_addrs: asArray(b['cc']),
      subject: String(b['subject'] ?? ''),
      message_id: b['message_id'] ? String(b['message_id']) : null,
      in_reply_to: b['in_reply_to'] ? String(b['in_reply_to']) : null,
      reference_ids: refs,
      body_text: String(b['text'] ?? b['body_text'] ?? ''),
      has_attachments: false,
    };
  },

  async send(input: SendInput): Promise<SendResult> {
    // 合成一个稳定形态的 Message-ID; 用 from 域名后缀, 不依赖随机时间 (测试可断言后缀)
    const rand = Math.random().toString(36).slice(2, 10);
    const domain = input.from_addr.split('@')[1] ?? 'mail.localhost';
    const message_id = `<${rand}@${domain}>`;
    console.log(`[email/fake] (not really sending) to=${input.to.join(',')} subj="${input.subject}" → ${message_id}`);
    return { message_id };
  },
});
```

- [ ] **Step 4: 跑测试看通过**

Run: `pnpm --filter @lingxi/gateway exec vitest run test/lib/email/fake-provider.test.ts`
Expected: PASS。

- [ ] **Step 5: (不单独 commit, 见 Task 7)**

---

## Task 6: Postmark provider

**Files:**
- Create: `apps/gateway/src/lib/email/postmark-provider.ts`
- Test: `apps/gateway/test/lib/email/postmark-provider.test.ts`

Postmark 入站 webhook JSON 关键字段:`To`(可能多个,用 `ToFull[].Email`)、`FromFull.Email`、`Subject`、`TextBody`、`StrippedTextReply`(去引用正文)、`MessageID`、`Headers`(数组,含 `In-Reply-To` / `References`)、`CcFull[]`、`Attachments[]`。出站 API:`POST https://api.postmarkapp.com/email`,头 `X-Postmark-Server-Token`,体 `{From, To, Cc, Subject, TextBody, Headers:[{Name,Value}]}`,响应含 `MessageID`。

- [ ] **Step 1: 写失败测试**

创建 `apps/gateway/test/lib/email/postmark-provider.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makePostmarkProvider } from '../../../src/lib/email/postmark-provider.js';

const provider = makePostmarkProvider({ serverToken: 'tok' });

describe('postmarkProvider.parseInbound', () => {
  it('解析 Postmark inbound JSON, 取 StrippedTextReply 优先', () => {
    const parsed = provider.parseInbound({
      OriginalRecipient: 'sunco@mail.lingxi.xxx',
      FromFull: { Email: 'bob@supplier.com' },
      ToFull: [{ Email: 'sunco@mail.lingxi.xxx' }],
      CcFull: [],
      Subject: '报价',
      TextBody: '请确认\n> 历史引用',
      StrippedTextReply: '请确认',
      MessageID: 'm1',
      Headers: [{ Name: 'In-Reply-To', Value: '<x@y>' }, { Name: 'References', Value: '<a@b> <c@d>' }],
      Attachments: [],
    });
    expect(parsed.to_localpart).toBe('sunco');
    expect(parsed.from_addr).toBe('bob@supplier.com');
    expect(parsed.body_text).toBe('请确认');                 // StrippedTextReply 优先
    expect(parsed.in_reply_to).toBe('<x@y>');
    expect(parsed.reference_ids).toEqual(['<a@b>', '<c@d>']);
  });
});

describe('postmarkProvider.send', () => {
  afterEach(() => vi.restoreAllMocks());
  it('POST /email 带 server token + 线程 Headers, 返回 MessageID', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ MessageID: 'sent-123' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await provider.send({
      from_addr: 'sunco@mail.lingxi.xxx', from_name: '灵犀',
      to: ['bob@supplier.com'], cc: [], subject: 'Re: 报价', body_text: '同意',
      in_reply_to: '<m1@x>', reference_ids: ['<m1@x>'],
    });
    expect(r.message_id).toBe('sent-123');
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.postmarkapp.com/email');
    expect((opts as any).headers['X-Postmark-Server-Token']).toBe('tok');
    const body = JSON.parse((opts as any).body);
    expect(body.From).toBe('灵犀 <sunco@mail.lingxi.xxx>');
    expect(body.Headers).toEqual(expect.arrayContaining([{ Name: 'In-Reply-To', Value: '<m1@x>' }]));
  });

  it('Postmark 返回非 ok → 抛错', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 422, text: async () => 'bad' }));
    await expect(provider.send({
      from_addr: 'a@b', from_name: 'x', to: ['c@d'], cc: [], subject: 's', body_text: 'b',
    })).rejects.toThrow(/422/);
  });
});
```

- [ ] **Step 2: 跑测试看失败**

Run: `pnpm --filter @lingxi/gateway exec vitest run test/lib/email/postmark-provider.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现 Postmark provider**

创建 `apps/gateway/src/lib/email/postmark-provider.ts`:

```typescript
import type { ParsedInboundEmail } from '@lingxi/shared';
import type { EmailProvider, SendInput, SendResult } from './provider.js';

interface PostmarkAddr { Email?: string }
interface PostmarkHeader { Name?: string; Value?: string }

const localpartOf = (addr: string): string => addr.split('@')[0]!.trim().toLowerCase();
const headerOf = (headers: PostmarkHeader[], name: string): string | null => {
  const h = headers.find((x) => (x.Name ?? '').toLowerCase() === name.toLowerCase());
  return h?.Value ?? null;
};

export interface PostmarkConfig { serverToken: string }

export const makePostmarkProvider = (cfg: PostmarkConfig): EmailProvider => ({
  parseInbound(body: unknown): ParsedInboundEmail {
    const b = (body ?? {}) as Record<string, unknown>;
    const toFull = (b['ToFull'] as PostmarkAddr[] | undefined) ?? [];
    const ccFull = (b['CcFull'] as PostmarkAddr[] | undefined) ?? [];
    const headers = (b['Headers'] as PostmarkHeader[] | undefined) ?? [];
    const recipient = (b['OriginalRecipient'] as string | undefined)
      ?? toFull[0]?.Email ?? '';
    if (!recipient || !recipient.includes('@')) throw new Error('postmark inbound: no recipient');
    const refsRaw = headerOf(headers, 'References') ?? '';
    const attachments = (b['Attachments'] as unknown[] | undefined) ?? [];
    return {
      to_localpart: localpartOf(recipient),
      from_addr: (b['FromFull'] as PostmarkAddr | undefined)?.Email ?? String(b['From'] ?? ''),
      to_addrs: toFull.map((a) => a.Email ?? '').filter(Boolean),
      cc_addrs: ccFull.map((a) => a.Email ?? '').filter(Boolean),
      subject: String(b['Subject'] ?? ''),
      message_id: b['MessageID'] ? String(b['MessageID']) : null,
      in_reply_to: headerOf(headers, 'In-Reply-To'),
      reference_ids: refsRaw.split(/\s+/).map((s) => s.trim()).filter(Boolean),
      // StrippedTextReply 去掉了引用历史, 优先; 没有则退回 TextBody
      body_text: String(b['StrippedTextReply'] ?? b['TextBody'] ?? ''),
      has_attachments: attachments.length > 0,
    };
  },

  async send(input: SendInput): Promise<SendResult> {
    const headers: PostmarkHeader[] = [];
    if (input.in_reply_to) headers.push({ Name: 'In-Reply-To', Value: input.in_reply_to });
    if (input.reference_ids?.length) {
      headers.push({ Name: 'References', Value: input.reference_ids.join(' ') });
    }
    const resp = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Postmark-Server-Token': cfg.serverToken,
      },
      body: JSON.stringify({
        From: `${input.from_name} <${input.from_addr}>`,
        To: input.to.join(', '),
        Cc: input.cc.length ? input.cc.join(', ') : undefined,
        Subject: input.subject,
        TextBody: input.body_text,
        Headers: headers,
        MessageStream: 'outbound',
      }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error(`postmark send failed ${resp.status}: ${t}`);
    }
    const json = await resp.json() as { MessageID?: string };
    return { message_id: json.MessageID ?? '' };
  },
});
```

- [ ] **Step 4: 跑测试看通过**

Run: `pnpm --filter @lingxi/gateway exec vitest run test/lib/email/postmark-provider.test.ts`
Expected: PASS。

- [ ] **Step 5: (不单独 commit, 见 Task 7)**

---

## Task 7: provider 工厂 + 提交 provider 层

**Files:**
- Create: `apps/gateway/src/lib/email/index.ts`

- [ ] **Step 1: 写工厂**

创建 `apps/gateway/src/lib/email/index.ts`:

```typescript
import type { EmailProvider } from './provider.js';
import { makeFakeProvider } from './fake-provider.js';
import { makePostmarkProvider } from './postmark-provider.js';

export type { EmailProvider, SendInput, SendResult } from './provider.js';

export interface EmailProviderConfig {
  provider: 'fake' | 'postmark';
  postmarkServerToken: string;
}

export const getEmailProvider = (cfg: EmailProviderConfig): EmailProvider => {
  if (cfg.provider === 'postmark') {
    return makePostmarkProvider({ serverToken: cfg.postmarkServerToken });
  }
  return makeFakeProvider();
};
```

- [ ] **Step 2: 类型检查 + 跑 provider 层全部测试**

Run: `pnpm --filter @lingxi/gateway lint && pnpm --filter @lingxi/gateway exec vitest run test/lib/email/`
Expected: lint 无错误;fake + postmark 测试全 PASS。

- [ ] **Step 3: Commit(Task 4+5+6+7 一起)**

```bash
git add apps/gateway/src/lib/email/ apps/gateway/test/lib/email/
git commit -m "$(cat <<'EOF'
feat(email): EmailProvider adapter + fake(dev)/postmark(prod) + 工厂

parseInbound 解析中立结构 (postmark 取 StrippedTextReply 去引用), send 带线程 Headers。
getEmailProvider 按 EMAIL_PROVIDER 选实现, 业务码不分支。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: email-dao

**Files:**
- Create: `apps/gateway/src/db/email-dao.ts`
- Test: `apps/gateway/test/db/email-dao.test.ts`

DAO 方法:`findUserByLocalpart(localpart)→userId|null`、`getAddress(userId)→{localpart,display_name}|null`、`insertInbound(parsed, userId)→id`、`insertOutbound(row)→id`、`list(userId, {q?, limit})→EmailListItem[]`、`get(userId, id)→EmailDetail|null`。

- [ ] **Step 1: 写失败测试(mock supabase client, 验证查询参数与映射)**

创建 `apps/gateway/test/db/email-dao.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { makeEmailDao } from '../../src/db/email-dao.js';

// 链式 mock: from().select().eq()...; 每个方法返回 self, 末端 await 返回 result。
function mockSb(result: any) {
  const calls: any = { filters: {} };
  const chain: any = {
    from: vi.fn(() => chain),
    select: vi.fn(() => chain),
    insert: vi.fn((row: any) => { calls.inserted = row; return chain; }),
    eq: vi.fn((k: string, v: any) => { calls.filters[k] = v; return chain; }),
    is: vi.fn(() => chain),
    or: vi.fn((expr: string) => { calls.or = expr; return chain; }),
    order: vi.fn(() => chain),
    limit: vi.fn((n: number) => { calls.limit = n; return chain; }),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then: (resolve: any) => resolve(result),
  };
  return { chain, calls };
}

describe('emailDao.findUserByLocalpart', () => {
  it('查到 → 返回 user_id', async () => {
    const { chain, calls } = mockSb({ data: { user_id: 'u1' }, error: null });
    const dao = makeEmailDao(chain as any);
    const uid = await dao.findUserByLocalpart('sunco');
    expect(uid).toBe('u1');
    expect(calls.filters['localpart']).toBe('sunco');
  });
  it('查不到 → null', async () => {
    const { chain } = mockSb({ data: null, error: null });
    const dao = makeEmailDao(chain as any);
    expect(await dao.findUserByLocalpart('nope')).toBeNull();
  });
});

describe('emailDao.insertInbound', () => {
  it('落 inbound 行, 生成 eml_ id', async () => {
    const { chain, calls } = mockSb({ data: null, error: null });
    const dao = makeEmailDao(chain as any);
    const id = await dao.insertInbound({
      to_localpart: 'sunco', from_addr: 'bob@x.com', to_addrs: ['sunco@m'], cc_addrs: [],
      subject: '报价', message_id: '<m1>', in_reply_to: null, reference_ids: [],
      body_text: '请确认', has_attachments: false,
    }, 'u1');
    expect(id).toMatch(/^eml_/);
    expect(calls.inserted.direction).toBe('inbound');
    expect(calls.inserted.user_id).toBe('u1');
    expect(calls.inserted.from_addr).toBe('bob@x.com');
  });
});

describe('emailDao.list', () => {
  it('映射成 EmailListItem (不含正文)', async () => {
    const rows = [{
      id: 'eml_1', direction: 'inbound', from_addr: 'b@x', to_addrs: ['s@m'],
      subject: '报价', has_attachments: false, received_at: '2026-06-07T00:00:00Z',
    }];
    const { chain, calls } = mockSb({ data: rows, error: null });
    const dao = makeEmailDao(chain as any);
    const out = await dao.list('u1', { limit: 10 });
    expect(out[0]!.id).toBe('eml_1');
    expect((out[0] as any).body_text).toBeUndefined();
    expect(calls.filters['user_id']).toBe('u1');
    expect(calls.limit).toBe(10);
  });
});
```

- [ ] **Step 2: 跑测试看失败**

Run: `pnpm --filter @lingxi/gateway exec vitest run test/db/email-dao.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现 DAO**

创建 `apps/gateway/src/db/email-dao.ts`:

```typescript
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ParsedInboundEmail, EmailListItem, EmailDetail,
} from '@lingxi/shared';

export interface OutboundInsert {
  user_id: string;
  from_addr: string;
  to_addrs: string[];
  cc_addrs: string[];
  subject: string;
  message_id: string;
  in_reply_to: string | null;
  reference_ids: string[];
  body_text: string;
}

export interface EmailDao {
  findUserByLocalpart(localpart: string): Promise<string | null>;
  getAddress(userId: string): Promise<{ localpart: string; display_name: string | null } | null>;
  insertInbound(parsed: ParsedInboundEmail, userId: string): Promise<string>;
  insertOutbound(row: OutboundInsert): Promise<string>;
  list(userId: string, opts: { q?: string; limit: number }): Promise<EmailListItem[]>;
  get(userId: string, id: string): Promise<EmailDetail | null>;
}

const newId = (): string =>
  `eml_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const LIST_COLS = 'id,direction,from_addr,to_addrs,subject,has_attachments,received_at';
const DETAIL_COLS = `${LIST_COLS},cc_addrs,message_id,in_reply_to,reference_ids,body_text`;

export const makeEmailDao = (sb: SupabaseClient): EmailDao => ({
  async findUserByLocalpart(localpart) {
    const { data, error } = await sb
      .from('email_addresses').select('user_id')
      .eq('localpart', localpart.toLowerCase()).maybeSingle();
    if (error) throw new Error(`findUserByLocalpart: ${error.message}`);
    return data ? (data as { user_id: string }).user_id : null;
  },

  async getAddress(userId) {
    const { data, error } = await sb
      .from('email_addresses').select('localpart,display_name')
      .eq('user_id', userId).maybeSingle();
    if (error) throw new Error(`getAddress: ${error.message}`);
    return data ? (data as { localpart: string; display_name: string | null }) : null;
  },

  async insertInbound(parsed, userId) {
    const id = newId();
    const { error } = await sb.from('emails').insert({
      id, user_id: userId, direction: 'inbound',
      from_addr: parsed.from_addr, to_addrs: parsed.to_addrs, cc_addrs: parsed.cc_addrs,
      subject: parsed.subject, message_id: parsed.message_id,
      in_reply_to: parsed.in_reply_to, reference_ids: parsed.reference_ids,
      body_text: parsed.body_text, has_attachments: parsed.has_attachments,
    });
    if (error) throw new Error(`insertInbound: ${error.message}`);
    return id;
  },

  async insertOutbound(row) {
    const id = newId();
    const { error } = await sb.from('emails').insert({
      id, user_id: row.user_id, direction: 'outbound',
      from_addr: row.from_addr, to_addrs: row.to_addrs, cc_addrs: row.cc_addrs,
      subject: row.subject, message_id: row.message_id,
      in_reply_to: row.in_reply_to, reference_ids: row.reference_ids,
      body_text: row.body_text, has_attachments: false,
    });
    if (error) throw new Error(`insertOutbound: ${error.message}`);
    return id;
  },

  async list(userId, opts) {
    let query = sb.from('emails').select(LIST_COLS).eq('user_id', userId);
    if (opts.q) {
      // 主题或发件人模糊匹配
      query = query.or(`subject.ilike.%${opts.q}%,from_addr.ilike.%${opts.q}%`);
    }
    const { data, error } = await query
      .order('received_at', { ascending: false })
      .limit(opts.limit);
    if (error) throw new Error(`list: ${error.message}`);
    return (data ?? []) as unknown as EmailListItem[];
  },

  async get(userId, id) {
    const { data, error } = await sb
      .from('emails').select(DETAIL_COLS)
      .eq('user_id', userId).eq('id', id).maybeSingle();
    if (error) throw new Error(`get: ${error.message}`);
    return data ? (data as unknown as EmailDetail) : null;
  },
});
```

- [ ] **Step 4: 跑测试看通过**

Run: `pnpm --filter @lingxi/gateway exec vitest run test/db/email-dao.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/db/email-dao.ts apps/gateway/test/db/email-dao.test.ts
git commit -m "$(cat <<'EOF'
feat(email): email-dao (localpart路由 / 收发落库 / 列表 / 详情)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: email router (inbound / list / get / send)

**Files:**
- Create: `apps/gateway/src/api/email.ts`
- Test: `apps/gateway/test/api/email.test.ts`

行为:
- `POST /api/email/inbound`:Basic-Auth(pass == `inboundWebhookSecret`)→ `provider.parseInbound(req.body)` → `findUserByLocalpart` → 找不到回 202(丢弃,不报错给服务商重投)→ `insertInbound` → `{ok:true,id}`。
- `GET /api/email/list`:containerAuth + email entitlement → `dao.list(userId, {q, limit})`。
- `GET /api/email/get?id=`:containerAuth + email entitlement → `dao.get` → 404 if null。
- `POST /api/email/send`:containerAuth + email entitlement → 算 from(`getAddress`)→ 若 `in_reply_to_id` 取原邮件线程头 + 收件人默认原发件人 → `provider.send` → `insertOutbound` → `{ok,id,message_id}`。

- [ ] **Step 1: 写失败测试**

创建 `apps/gateway/test/api/email.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { buildEmailRouter } from '../../src/api/email.js';
import { makeFakeProvider } from '../../src/lib/email/fake-provider.js';

const USER_ID = '6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f';
const SECRET = 'tsecret';

// containerAuth 替身: 直接放行并塞 user_id
const fakeContainerAuth = (req: any, _res: any, next: any) => { req.user_id = USER_ID; next(); };

function makeApp(daoOverrides: any = {}, entitlementActive = true) {
  const dao = {
    findUserByLocalpart: vi.fn().mockResolvedValue(USER_ID),
    getAddress: vi.fn().mockResolvedValue({ localpart: 'sunco', display_name: '顺' }),
    insertInbound: vi.fn().mockResolvedValue('eml_in'),
    insertOutbound: vi.fn().mockResolvedValue('eml_out'),
    list: vi.fn().mockResolvedValue([{ id: 'eml_1', direction: 'inbound', from_addr: 'b@x', to_addrs: [], subject: '报价', has_attachments: false, received_at: 't' }]),
    get: vi.fn().mockResolvedValue({ id: 'eml_1', direction: 'inbound', from_addr: 'b@x', to_addrs: [], cc_addrs: [], subject: '报价', message_id: '<m1>', in_reply_to: null, reference_ids: [], body_text: '请确认', has_attachments: false, received_at: 't' }),
    ...daoOverrides,
  };
  const app = express();
  app.use(express.json());
  app.use(buildEmailRouter({
    dao: dao as any,
    provider: makeFakeProvider(),
    config: { domain: 'mail.localhost', fromDefaultName: '灵犀助理', inboundWebhookSecret: SECRET },
    containerAuth: fakeContainerAuth as any,
    requireEmailEntitlement: ((_req: any, res: any, next: any) =>
      entitlementActive ? next() : res.status(403).json({ error: 'no email' })) as any,
  }));
  return { app, dao };
}

describe('POST /api/email/inbound', () => {
  it('Basic-Auth 错 → 401', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/email/inbound')
      .auth('x', 'wrong').send({ to: 'sunco@mail.localhost', from: 'b@x' });
    expect(res.status).toBe(401);
  });

  it('正确 secret + 已知 localpart → 落库 200', async () => {
    const { app, dao } = makeApp();
    const res = await request(app).post('/api/email/inbound')
      .auth('postmark', SECRET)
      .send({ to: 'sunco@mail.localhost', from: 'bob@supplier.com', subject: '报价', text: '请确认' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, id: 'eml_in' });
    expect(dao.insertInbound).toHaveBeenCalled();
  });

  it('未知 localpart → 202 丢弃, 不落库', async () => {
    const { app, dao } = makeApp({ findUserByLocalpart: vi.fn().mockResolvedValue(null) });
    const res = await request(app).post('/api/email/inbound')
      .auth('postmark', SECRET)
      .send({ to: 'ghost@mail.localhost', from: 'b@x' });
    expect(res.status).toBe(202);
    expect(dao.insertInbound).not.toHaveBeenCalled();
  });
});

describe('GET /api/email/list', () => {
  it('entitlement 关 → 403', async () => {
    const { app } = makeApp({}, false);
    const res = await request(app).get('/api/email/list');
    expect(res.status).toBe(403);
  });
  it('返回列表', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/email/list?q=报价&limit=5');
    expect(res.status).toBe(200);
    expect(res.body.emails[0].id).toBe('eml_1');
  });
});

describe('GET /api/email/get', () => {
  it('找不到 → 404', async () => {
    const { app } = makeApp({ get: vi.fn().mockResolvedValue(null) });
    const res = await request(app).get('/api/email/get?id=nope');
    expect(res.status).toBe(404);
  });
  it('返回详情', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/email/get?id=eml_1');
    expect(res.status).toBe(200);
    expect(res.body.email.body_text).toBe('请确认');
  });
});

describe('POST /api/email/send', () => {
  it('reply: 带 in_reply_to_id → 线程头 + 收件人默认原发件人 + 落 outbound', async () => {
    const { app, dao } = makeApp();
    const res = await request(app).post('/api/email/send')
      .send({ in_reply_to_id: 'eml_1', subject: 'Re: 报价', body_text: '同意', to: [] });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('eml_out');
    expect(res.body.message_id).toMatch(/@mail\.localhost>$/);
    const outRow = dao.insertOutbound.mock.calls[0]![0];
    expect(outRow.to_addrs).toEqual(['b@x']);          // 原邮件 from_addr
    expect(outRow.in_reply_to).toBe('<m1>');           // 原邮件 message_id
    expect(outRow.from_addr).toBe('sunco@mail.localhost');
  });

  it('新发: 显式 to', async () => {
    const { app, dao } = makeApp();
    const res = await request(app).post('/api/email/send')
      .send({ to: ['x@y.com'], subject: '询价', body_text: '在吗' });
    expect(res.status).toBe(200);
    expect(dao.insertOutbound.mock.calls[0]![0].to_addrs).toEqual(['x@y.com']);
  });

  it('既无 to 又无 in_reply_to_id → 400', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/email/send').send({ subject: 's', body_text: 'b', to: [] });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: 跑测试看失败**

Run: `pnpm --filter @lingxi/gateway exec vitest run test/api/email.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现 router**

创建 `apps/gateway/src/api/email.ts`:

```typescript
import { Router, type Router as RouterType, type Request, type Response, type RequestHandler } from 'express';
import type {
  EmailListResponse, EmailDetailResponse, EmailSendRequest, EmailSendResponse,
} from '@lingxi/shared';
import type { EmailDao } from '../db/email-dao.js';
import type { EmailProvider } from '../lib/email/index.js';

export interface EmailRouterConfig {
  domain: string;
  fromDefaultName: string;
  inboundWebhookSecret: string;
}

export interface EmailRouterDeps {
  dao: EmailDao;
  provider: EmailProvider;
  config: EmailRouterConfig;
  /** 容器 token 中间件 (塞 req.user_id) */
  containerAuth: RequestHandler;
  /** email entitlement gate (containerAuth 之后) */
  requireEmailEntitlement: RequestHandler;
}

const DEFAULT_LIST_LIMIT = 30;
const MAX_LIST_LIMIT = 100;

export const buildEmailRouter = (deps: EmailRouterDeps): RouterType => {
  const router = Router();
  const { dao, provider, config } = deps;

  // ---- 入站: Basic-Auth, 不走容器 token ----
  router.post('/api/email/inbound', async (req: Request, res: Response) => {
    // Basic-Auth: Authorization: Basic base64(user:pass), 校验 pass
    const auth = req.headers['authorization'] ?? '';
    let ok = false;
    if (auth.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
        const pass = decoded.slice(decoded.indexOf(':') + 1);
        ok = pass === config.inboundWebhookSecret;
      } catch { ok = false; }
    }
    if (!ok) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    let parsed;
    try {
      parsed = provider.parseInbound(req.body);
    } catch (err) {
      res.status(400).json({ error: 'parse failed', message: String(err) });
      return;
    }

    try {
      const userId = await dao.findUserByLocalpart(parsed.to_localpart);
      if (!userId) {
        // 未知收件人: 丢弃但回 202, 让服务商别重投/别报错
        res.status(202).json({ ok: true, dropped: 'unknown recipient' });
        return;
      }
      const id = await dao.insertInbound(parsed, userId);
      res.json({ ok: true, id });
    } catch (err) {
      res.status(500).json({ error: 'internal', message: String(err) });
    }
  });

  // ---- 以下走 containerAuth + email entitlement ----
  router.get('/api/email/list', deps.containerAuth, deps.requireEmailEntitlement,
    async (req: Request, res: Response) => {
      const userId = req.user_id!;
      const q = (req.query['q'] as string | undefined)?.trim() || undefined;
      const rawLimit = parseInt((req.query['limit'] as string) ?? '', 10);
      const limit = Number.isFinite(rawLimit)
        ? Math.min(Math.max(rawLimit, 1), MAX_LIST_LIMIT)
        : DEFAULT_LIST_LIMIT;
      try {
        const emails = await dao.list(userId, { q, limit });
        const body: EmailListResponse = { emails };
        res.json(body);
      } catch (err) {
        res.status(500).json({ error: 'internal', message: String(err) });
      }
    });

  router.get('/api/email/get', deps.containerAuth, deps.requireEmailEntitlement,
    async (req: Request, res: Response) => {
      const userId = req.user_id!;
      const id = req.query['id'] as string | undefined;
      if (!id) { res.status(400).json({ error: 'id required' }); return; }
      try {
        const email = await dao.get(userId, id);
        if (!email) { res.status(404).json({ error: 'not found' }); return; }
        const body: EmailDetailResponse = { email };
        res.json(body);
      } catch (err) {
        res.status(500).json({ error: 'internal', message: String(err) });
      }
    });

  router.post('/api/email/send', deps.containerAuth, deps.requireEmailEntitlement,
    async (req: Request, res: Response) => {
      const userId = req.user_id!;
      const b = (req.body ?? {}) as EmailSendRequest;
      try {
        const addr = await dao.getAddress(userId);
        if (!addr) { res.status(409).json({ error: 'no email address provisioned' }); return; }
        const fromAddr = `${addr.localpart}@${config.domain}`;
        const fromName = addr.display_name || config.fromDefaultName;

        // 线程: 给定 in_reply_to_id 时取原邮件
        let to = Array.isArray(b.to) ? b.to.filter(Boolean) : [];
        let cc = Array.isArray(b.cc) ? b.cc.filter(Boolean) : [];
        let inReplyTo: string | null = null;
        let references: string[] = [];
        let subject = b.subject ?? '';

        if (b.in_reply_to_id) {
          const orig = await dao.get(userId, b.in_reply_to_id);
          if (!orig) { res.status(404).json({ error: 'in_reply_to_id not found' }); return; }
          if (to.length === 0) to = [orig.from_addr];          // 默认回原发件人
          inReplyTo = orig.message_id;
          references = [...orig.reference_ids, ...(orig.message_id ? [orig.message_id] : [])];
          if (!subject) subject = orig.subject.startsWith('Re:') ? orig.subject : `Re: ${orig.subject}`;
        }

        if (to.length === 0) {
          res.status(400).json({ error: 'to required (or give in_reply_to_id)' });
          return;
        }

        const { message_id } = await provider.send({
          from_addr: fromAddr, from_name: fromName,
          to, cc, subject, body_text: b.body_text ?? '',
          in_reply_to: inReplyTo ?? undefined,
          reference_ids: references,
        });

        const id = await dao.insertOutbound({
          user_id: userId, from_addr: fromAddr, to_addrs: to, cc_addrs: cc,
          subject, message_id, in_reply_to: inReplyTo, reference_ids: references,
          body_text: b.body_text ?? '',
        });

        const out: EmailSendResponse = { ok: true, id, message_id };
        res.json(out);
      } catch (err) {
        res.status(500).json({ error: 'internal', message: String(err) });
      }
    });

  return router;
};
```

- [ ] **Step 4: 跑测试看通过**

Run: `pnpm --filter @lingxi/gateway exec vitest run test/api/email.test.ts`
Expected: PASS(全部用例)。

- [ ] **Step 5: 类型检查**

Run: `pnpm --filter @lingxi/gateway lint`
Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/api/email.ts apps/gateway/test/api/email.test.ts
git commit -m "$(cat <<'EOF'
feat(email): email router (inbound Basic-Auth 落库 + list/get/send 线程)

inbound 未知收件人回 202 丢弃; send 带 in_reply_to_id 自动接线程头+回原发件人+Re:。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: 挂载到 index.ts + email entitlement gate

**Files:**
- Modify: `apps/gateway/src/api/email.ts`(导出一个 `makeEmailEntitlementMiddleware` 工厂, 与 cloud 的 `requireCloudForContainer` 同形)
- Modify: `apps/gateway/src/index.ts`
- Test: 复用 Task 9 测试(已覆盖 entitlement gate 行为)

- [ ] **Step 1: 在 email.ts 末尾加 entitlement 中间件工厂**

在 `apps/gateway/src/api/email.ts` 末尾(`buildEmailRouter` 之后)追加:

```typescript
import type { EntitlementsDao } from '../db/entitlements-dao.js';

/** email entitlement gate: containerAuth 之后用, 查 user 是否 active 'email'. */
export const makeEmailEntitlementMiddleware = (
  entitlements: Pick<EntitlementsDao, 'listActive'>,
): RequestHandler => async (req, res, next) => {
  const userId = req.user_id!;
  try {
    const active = await entitlements.listActive(userId);
    if (!active.includes('email')) {
      res.status(403).json({ error: 'email entitlement not active' });
      return;
    }
    next();
  } catch (err) {
    res.status(500).json({ error: 'internal', message: String(err) });
  }
};
```

(把顶部 import 合并:`EntitlementsDao` 与现有 import 不冲突,新增一行 import 即可。)

- [ ] **Step 2: index.ts 构造 provider + 挂 router**

在 `apps/gateway/src/index.ts`:

(a) 顶部 import 区加:

```typescript
import { buildEmailRouter, makeEmailEntitlementMiddleware } from './api/email.js';
import { getEmailProvider } from './lib/email/index.js';
import { makeEmailDao } from './db/email-dao.js';
import { makeContainerTokenMiddleware } from './auth/container-token.js';
```

(b) 在 `if (sbResolved) {` 块内、`buildMeEntitlementsRouter` 挂载之后,追加:

```typescript
    // 邮件能力 (B1): inbound webhook (Basic-Auth) + 容器侧 list/get/send (containerAuth + email entitlement)
    {
      const emailDao = makeEmailDao(sbResolved);
      const emailProvider = getEmailProvider({
        provider: config.email.provider,
        postmarkServerToken: config.email.postmarkServerToken,
      });
      const emailContainerAuth = makeContainerTokenMiddleware({
        secret: config.auth.gatewaySecret,
        tokenVersionFetcher: (uid) => entitlementsDao.getTokenVersion(uid),
      });
      app.use(buildEmailRouter({
        dao: emailDao,
        provider: emailProvider,
        config: {
          domain: config.email.domain,
          fromDefaultName: config.email.fromDefaultName,
          inboundWebhookSecret: config.email.inboundWebhookSecret,
        },
        containerAuth: emailContainerAuth,
        requireEmailEntitlement: makeEmailEntitlementMiddleware(entitlementsDao),
      }));
      console.log(`[gateway] email routes mounted (provider=${config.email.provider}, domain=${config.email.domain})`);
    }
```

- [ ] **Step 3: 类型检查 + 全 gateway 测试**

Run: `pnpm --filter @lingxi/gateway lint && pnpm --filter @lingxi/gateway test`
Expected: lint 无错误;全测试 PASS(含新增 email 测试)。

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/src/api/email.ts apps/gateway/src/index.ts
git commit -m "$(cat <<'EOF'
feat(email): 挂载 email router + email entitlement gate

index 构造 provider(按 EMAIL_PROVIDER)+ emailDao + 容器 token 中间件, 挂 /api/email/*。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: 本地 dev-fake 端到端冒烟(手动)

**Files:** 无(验证任务)

前提:本地 supabase 已应用 0007;`apps/gateway/.env.local` 里 `EMAIL_PROVIDER=fake`(缺省即 fake)、`POSTMARK_INBOUND_WEBHOOK_SECRET=dev-inbound-secret`(或与 .env.local 一致)。

- [ ] **Step 1: 给测试用户插一条 email 地址 + entitlement**

用真实 dev 用户(`container_mapping` 里 status=ready 那个 user_id)。通过本地 supabase REST(见 `.env.local` 的 SUPABASE_URL/KEY):

```bash
set -a; . apps/gateway/.env.local; set +a
UID=fe83956f-9625-44fe-9b04-6351609779d6   # 换成你的真实 dev user_id
curl -s "$SUPABASE_URL/rest/v1/email_addresses" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "Content-Type: application/json" \
  -d "{\"localpart\":\"sunco\",\"user_id\":\"$UID\",\"display_name\":\"顺嘉贸易\"}"
curl -s "$SUPABASE_URL/rest/v1/user_entitlements" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "Content-Type: application/json" \
  -d "{\"user_id\":\"$UID\",\"feature\":\"email\"}"
```

- [ ] **Step 2: 起 gateway(或已在 pnpm dev),模拟一封入站**

```bash
curl -s -u "postmark:dev-inbound-secret" -X POST http://localhost:9000/api/email/inbound \
  -H "Content-Type: application/json" \
  -d '{"to":"sunco@mail.localhost","from":"bob@supplier.com","subject":"报价确认","text":"请确认 5000 件的价格"}'
```
Expected: `{"ok":true,"id":"eml_..."}`

- [ ] **Step 3: 用容器 token 列收件箱**

```bash
TOK=$(cat ~/.hermes-dev/.hermes/.laifu_user_token)
curl -s -H "Authorization: Bearer $TOK" "http://localhost:9000/api/email/list" | python3 -m json.tool
```
Expected: 列表含刚落库那封(subject "报价确认", from bob@supplier.com)。

- [ ] **Step 4: 回复(fake 不真发, 落 outbound)**

```bash
EID=<上一步拿到的 eml_id>
curl -s -H "Authorization: Bearer $TOK" -X POST http://localhost:9000/api/email/send \
  -H "Content-Type: application/json" \
  -d "{\"in_reply_to_id\":\"$EID\",\"body_text\":\"同意, 按此推进\"}" | python3 -m json.tool
```
Expected: `{"ok":true,"id":"eml_...","message_id":"<...@mail.localhost>"}`;再 list 能看到该 outbound 行(direction=outbound, to=bob@supplier.com, subject "Re: 报价确认")。

- [ ] **Step 5: 验证完成(无代码改动,无需 commit)** —— B1 后端数据面在 dev-fake 下闭环通过。

---

## Self-Review 记录

- **Spec 覆盖**(§二~§六):emails/email_addresses 表(Task 1)、契约(Task 2)、provider adapter+fake+postmark(Task 4-7)、inbound 落库 Basic-Auth(Task 9)、list/get/send 线程(Task 9)、email entitlement gate(Task 10)、按 EMAIL_PROVIDER 切不分支(Task 7/10)。**附件/raw eml(§三的 raw_blob_key/attachment_keys)本期建列留空**,Blob 存取明确推迟,已在文件头声明。
- **推迟项**:容器 CLI(B2)、provisioning 分配 handle + web 能力卡 + 网关 `email` 白名单(B3)、bicep prod env、附件 Blob。均在文件头"不含"列出。
- **类型一致**:`ParsedInboundEmail`/`EmailListItem`/`EmailDetail`/`EmailSendRequest`/`EmailSendResponse`(shared, Task 2)在 dao(Task 8)/router(Task 9)一致;`EmailProvider`/`SendInput`/`SendResult`(Task 4)在 fake/postmark/工厂/router 一致;`reference_ids` 列名(避开 SQL 关键字 `references`)在 migration/dao/contracts 全程一致。
- **每个 commit 绿**:纯新增文件为主;Task 10 改 index.ts 是追加挂载,不动现有路由。provider 层 Task 4-7 合并一个 commit(中间 Task 4 接口无测试)。
- **dev 可测**:Task 11 用 fake provider + 手动 curl 跑通入站→列→回复,无需 Postmark/域名/DNS。
- **B1 独立可用**:做完即"后端数据面可用 + 本地闭环",是完整可测试切片。
