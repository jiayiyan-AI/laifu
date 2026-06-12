# 入站邮件附件落 Blob + 可下载 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 入站邮件的附件落到 Azure Blob 专用容器,助手能经 gateway 端点下载。

**Architecture:** 方案 B(见 spec `docs/superpowers/specs/2026-06-12-inbound-email-attachments-design.md`)。CF Email Worker 用 postal-mime 解析后:① 调 gateway `POST /api/email/inbound/prepare`(gateway 查收件人归属,已知则为每个附件生成独立随机 `attId` + 签 **write-SAS**)② 用 SAS 直接 PUT 到 Azure Blob ③ 调 `POST /api/email/inbound`(commit)把解析结果 + `attachment_keys` 落库。下载经新 `GET /api/email/attachment` 签 **read-SAS**。附件存储与 `email_id`/`userId` 解耦;隔离/鉴权在 DB+gateway 层。解析全程在 Worker,gateway 不解析邮件。

**Tech Stack:** TypeScript(gateway Express + vitest)、Drizzle(`@lingxi/db`)、`@azure/storage-blob`(SAS via `apps/gateway/src/lib/sas-builder.ts`)、Cloudflare Worker(wrangler + postal-mime)。

**复用**:`buildReadBlobSas`(已有)、`buildContentDisposition`(已有)、`udkCache`/`blobServiceClient`(cloud.ts 同源)。

**分支**:`feat/email-inbound-attachments`(已开,spec 已提交 `576b7b2`)。

**不在本次**:出站附件、容器 `email` CLI 附件交互、raw .eml 留存。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `packages/shared/src/contracts.ts` | `AttachmentRef` 类型 + `ParsedInboundEmail.attachment_keys` + `EmailDetail.attachment_keys` | 改 |
| `apps/gateway/src/lib/sas-builder.ts` | 新增 `buildWriteBlobSas`(blob-scoped 写 SAS) | 改 |
| `apps/gateway/src/lib/email/resend-provider.ts` | `parseInbound` 读 `attachment_keys` | 改 |
| `apps/gateway/src/db/email-dao.ts` | `insertInbound` 写 `attachment_keys`;`get` 返回 `attachment_keys` | 改 |
| `apps/gateway/src/api/email.ts` | 新 `prepare` + `attachment` 端点;commit 写 keys;deps 加可选 blob 依赖 | 改 |
| `apps/gateway/src/config.ts` + `.env.example` | `EMAIL_ATTACHMENT_CONTAINER` | 改 |
| `apps/gateway/src/index.ts` | 上移 blob client 构造,注入 email router | 改 |
| `infra/bicep/main.bicep` | `email-attachments` 容器 + appSetting | 改 |
| `infra/cloudflare-email-worker/src/index.ts` | prepare→PUT→commit + setReject | 改 |
| `infra/cloudflare-email-worker/README.md` + `OWNER-NOTES.md` | 附件流 + 容器前置 | 改 |
| 各 `*.test.ts` | 单测 | 改/建 |

---

## Task 1: shared 加 AttachmentRef + attachment_keys 字段

**Files:**
- Modify: `packages/shared/src/contracts.ts:333-370`

- [ ] **Step 1: 加类型与字段**

在 `contracts.ts` 的 `// === 邮件能力 (B1) ===` 注释下方(`ParsedInboundEmail` 之前)加:

```typescript
/** 一个入站附件在 Blob 里的引用 + 元数据。key 是 email-attachments 容器内相对路径,不含 userId。 */
export interface AttachmentRef {
  key: string;          // e.g. "01JAB...-quote.pdf"
  filename: string;     // 原始文件名(展示 + 下载 content-disposition)
  content_type: string; // MIME, 缺省 "application/octet-stream"
  size: number;         // 字节
}
```

在 `ParsedInboundEmail` 末尾(`has_attachments` 之后)加一行:

```typescript
  attachment_keys: AttachmentRef[];  // 无附件则 []
```

在 `EmailDetail`(`extends EmailListItem`)末尾(`body_text` 之后)加一行:

```typescript
  attachment_keys: AttachmentRef[];
```

- [ ] **Step 2: build shared 验证编译**

Run: `pnpm --filter @lingxi/shared build`
Expected: 无类型错误,`packages/shared/dist` 更新。

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/contracts.ts
git commit -m "feat(email): shared 加 AttachmentRef + attachment_keys 字段"
```

---

## Task 2: sas-builder 加 buildWriteBlobSas(blob-scoped 写 SAS)

**Files:**
- Modify: `apps/gateway/src/lib/sas-builder.ts`(在 `buildReadBlobSas` 之后追加)
- Test: `apps/gateway/test/lib/sas-builder.test.ts`(若不存在则新建)

- [ ] **Step 1: 写失败测试**

新建/追加 `apps/gateway/test/lib/sas-builder.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildWriteBlobSas } from '../../src/lib/sas-builder.js';

const udk = {
  signedObjectId: '11111111-1111-1111-1111-111111111111',
  signedTenantId: '22222222-2222-2222-2222-222222222222',
  signedStartsOn: new Date('2026-06-12T00:00:00Z'),
  signedExpiresOn: new Date('2026-06-19T00:00:00Z'),
  signedService: 'b',
  signedVersion: '2020-02-10',
  value: Buffer.from('test-key-bytes').toString('base64'),
} as any;

describe('buildWriteBlobSas', () => {
  it('签出 blob-scoped(sr=b)写 SAS, 含 create/write 权限', () => {
    const out = buildWriteBlobSas({
      account: 'stlingxilaifu',
      container: 'email-attachments',
      blobName: '01JABC-quote.pdf',
      udk,
      ttlSeconds: 300,
    });
    expect(out.sasToken).toMatch(/sr=b/);
    expect(out.sasToken).toMatch(/sp=/);             // 有权限字段
    expect(decodeURIComponent(out.sasToken)).toMatch(/[cw]/); // create/write
    expect(out.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/gateway && pnpm vitest run test/lib/sas-builder.test.ts`
Expected: FAIL — `buildWriteBlobSas is not a function`。

- [ ] **Step 3: 实现 buildWriteBlobSas**

在 `apps/gateway/src/lib/sas-builder.ts` 末尾追加(复用文件顶部已 import 的 `BlobSASPermissions`/`SASProtocol`/`generateBlobSASQueryParameters`):

```typescript
// === Write SAS (sr=b, blob-scoped) — 给 CF Worker 直传单个附件 blob 用 ===

export interface WriteBlobSasInput {
  account: string;
  container: string;
  blobName: string;   // email-attachments 容器内相对路径,如 "01JABC-quote.pdf"
  udk: UserDelegationKey;
  ttlSeconds: number; // 推荐 300 (5min)
}

export interface WriteBlobSasOutput {
  sasToken: string;
  expiresAt: Date;
}

/**
 * blob-scoped 写 SAS(create + write),最小授权:仅该 blob、仅写、短 TTL。
 * 与 buildReadBlobSas 同构,用 SDK(sr=b 原生支持)。
 */
export function buildWriteBlobSas(input: WriteBlobSasInput): WriteBlobSasOutput {
  const startsOn = new Date(Date.now() - 60 * 1000);
  const expiresOn = new Date(Date.now() + input.ttlSeconds * 1000);
  const permissions = BlobSASPermissions.from({ create: true, write: true });

  const toDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));
  const normalizedUdk: UserDelegationKey = {
    ...input.udk,
    signedStartsOn: toDate(input.udk.signedStartsOn),
    signedExpiresOn: toDate(input.udk.signedExpiresOn),
  };

  const sasQueryParams = generateBlobSASQueryParameters(
    {
      containerName: input.container,
      blobName: input.blobName,
      permissions,
      protocol: SASProtocol.Https,
      startsOn,
      expiresOn,
      version: '2020-02-10',
    },
    normalizedUdk,
    input.account,
  );

  return { sasToken: sasQueryParams.toString(), expiresAt: expiresOn };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/gateway && pnpm vitest run test/lib/sas-builder.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/lib/sas-builder.ts apps/gateway/test/lib/sas-builder.test.ts
git commit -m "feat(email): sas-builder 加 buildWriteBlobSas (blob-scoped 写 SAS)"
```

---

## Task 3: email-dao 写/读 attachment_keys

**Files:**
- Modify: `apps/gateway/src/db/email-dao.ts:62-79`(insertInbound)+ `127-150`(get)
- Test: `apps/gateway/test/db/email-dao.test.ts`(沿用现有 harness,跑本地 PG :54422)

- [ ] **Step 1: insertInbound 写 attachment_keys**

`insertInbound` 的 `db.insert(em).values({...})` 里,`has_attachments: parsed.has_attachments,` 之后加一行:

```typescript
        attachment_keys: parsed.attachment_keys,
```

- [ ] **Step 2: get 返回 attachment_keys**

`get` 的 `db.select({...})` 字段表里,`has_attachments: em.has_attachments,` 之后加一行:

```typescript
        attachment_keys: em.attachment_keys,
```

- [ ] **Step 3: 加断言测试**

在 `apps/gateway/test/db/email-dao.test.ts` 已有的 inbound 落库用例里(或新增一例),给 `insertInbound` 传入带附件的 `parsed`(`attachment_keys: [{key:'k0-a.pdf',filename:'a.pdf',content_type:'application/pdf',size:10}]`),再 `get` 回来断言:

```typescript
expect(detail!.attachment_keys).toEqual([
  { key: 'k0-a.pdf', filename: 'a.pdf', content_type: 'application/pdf', size: 10 },
]);
```

(注:若现有用例的 `parsed` 没有 `attachment_keys` 字段,补 `attachment_keys: []`,因 Task 1 已设为必填。)

- [ ] **Step 4: 跑测试**

Run: `cd apps/gateway && pnpm vitest run test/db/email-dao.test.ts`
Expected: PASS(需本地 PG 在跑:`./scripts/dev-db.sh start` + 已 `db:push`)。

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/db/email-dao.ts apps/gateway/test/db/email-dao.test.ts
git commit -m "feat(email): email-dao 读写 attachment_keys"
```

---

## Task 4: resend-provider.parseInbound 解析 attachment_keys

**Files:**
- Modify: `apps/gateway/src/lib/email/resend-provider.ts:25-44`(parseInbound 的 return)
- Modify: `apps/gateway/src/lib/email/fake-provider.ts` + `postmark-provider.ts`(补 `attachment_keys: []`,因类型必填)
- Test: `apps/gateway/test/lib/email/resend-provider.test.ts`

- [ ] **Step 1: 写失败测试**

在 `resend-provider.test.ts` 的 `parseInbound` describe 里加:

```typescript
it('解析 attachment_keys(Worker commit 带来的)', () => {
  const parsed = p.parseInbound({
    to: 'sunco@laifu.uncagedai.org', from_addr: 'b@x.com',
    subject: 's', text: 't',
    attachment_keys: [{ key: '01J-a.pdf', filename: 'a.pdf', content_type: 'application/pdf', size: 99 }],
  });
  expect(parsed.attachment_keys).toEqual([
    { key: '01J-a.pdf', filename: 'a.pdf', content_type: 'application/pdf', size: 99 },
  ]);
});
it('无 attachment_keys 时回 []', () => {
  const parsed = p.parseInbound({ to: 'sunco@laifu.uncagedai.org' });
  expect(parsed.attachment_keys).toEqual([]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/gateway && pnpm vitest run test/lib/email/resend-provider.test.ts`
Expected: FAIL — `attachment_keys` undefined。

- [ ] **Step 3: 实现**

`resend-provider.ts` 的 `parseInbound` return 对象里,`has_attachments: Boolean(b['has_attachments']),` 改为按附件推导 + 加 keys:

```typescript
      has_attachments: Array.isArray(b['attachment_keys']) ? b['attachment_keys'].length > 0 : Boolean(b['has_attachments']),
      attachment_keys: Array.isArray(b['attachment_keys'])
        ? (b['attachment_keys'] as AttachmentRef[]).map((a) => ({
            key: String(a.key),
            filename: String(a.filename ?? 'attachment'),
            content_type: String(a.content_type ?? 'application/octet-stream'),
            size: Number(a.size ?? 0),
          }))
        : [],
```

文件顶部 import 加 `AttachmentRef`:

```typescript
import type { ParsedInboundEmail, AttachmentRef } from '@lingxi/shared';
```

`fake-provider.ts` 与 `postmark-provider.ts` 的 `parseInbound` return 里各补一行 `attachment_keys: [],`(置于 `has_attachments` 之后)以满足类型。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/gateway && pnpm vitest run test/lib/email`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/lib/email/*.ts apps/gateway/test/lib/email/resend-provider.test.ts
git commit -m "feat(email): provider.parseInbound 解析 attachment_keys"
```

---

## Task 5: gateway 新增 prepare 端点

**Files:**
- Modify: `apps/gateway/src/api/email.ts`(deps 接口 + Basic-Auth 抽成 helper + 新 prepare 路由)
- Test: `apps/gateway/test/api/email.test.ts`

设计:prepare 与 inbound 共用 Basic-Auth 校验。新增可选 `attachments` 依赖(blob 相关),缺省时 prepare 回 501。

- [ ] **Step 1: deps 接口加可选 blob 依赖**

`apps/gateway/src/api/email.ts` 顶部 import 加:

```typescript
import { buildWriteBlobSas, buildReadBlobSas } from '../lib/sas-builder.js';
import { buildContentDisposition } from '../lib/content-disposition.js';
import type { UserDelegationKeyCache } from '../lib/user-delegation-key-cache.js';
import type { AttachmentRef } from '@lingxi/shared';
import { randomUUID } from 'node:crypto';
```

`EmailRouterDeps` 加一个可选字段:

```typescript
  /** 附件存储依赖;未配置(无 Azure)时附件相关端点回 501 */
  attachments?: {
    udkCache: Pick<UserDelegationKeyCache, 'get'>;
    accountName: string;
    container: string;       // email-attachments
    blobEndpoint: string;
    writeSasTtlSeconds: number;
    readSasTtlSeconds: number;
  };
```

- [ ] **Step 2: Basic-Auth 抽 helper(DRY inbound + prepare)**

在 `buildEmailRouter` 内、`router.post('/api/email/inbound'...)` 之前加:

```typescript
  const checkInboundAuth = (req: Request): boolean => {
    const auth = req.headers['authorization'] ?? '';
    if (!auth.startsWith('Basic ')) return false;
    try {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const pass = decoded.slice(decoded.indexOf(':') + 1);
      return pass === config.inboundWebhookSecret;
    } catch { return false; }
  };
```

把现有 inbound handler 里那段 Basic 校验(`const auth = ...; let ok=false; ... if(!ok){401}`)替换为:

```typescript
    if (!checkInboundAuth(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
```

- [ ] **Step 3: 写失败测试**

在 `test/api/email.test.ts` 加(沿用文件已有的 `makeApp`/`SECRET`/`USER_ID` + supertest;`makeApp` 需支持传入 `attachments` dep——见 Step 5 调整):

```typescript
it('prepare: 已知收件人为每个附件签 write-SAS', async () => {
  const app = makeApp({}, true, /*withAttachments*/ true);
  const res = await request(app).post('/api/email/inbound/prepare')
    .set('Authorization', 'Basic ' + Buffer.from('cf:' + SECRET).toString('base64'))
    .send({ to_localpart: 'sunco', attachments: [
      { filename: 'quote.pdf', content_type: 'application/pdf', size: 100 },
    ]});
  expect(res.status).toBe(200);
  expect(res.body.recipient).toBe('ok');
  expect(res.body.uploads).toHaveLength(1);
  expect(res.body.uploads[0]).toMatchObject({ idx: 0 });
  expect(res.body.uploads[0].key).toMatch(/quote\.pdf$/);
  expect(res.body.uploads[0].sas_url).toContain('email-attachments');
  expect(res.body).not.toHaveProperty('email_id');
});

it('prepare: 未知收件人不签 SAS', async () => {
  const app = makeApp({ findUserByLocalpart: vi.fn().mockResolvedValue(null) }, true, true);
  const res = await request(app).post('/api/email/inbound/prepare')
    .set('Authorization', 'Basic ' + Buffer.from('cf:' + SECRET).toString('base64'))
    .send({ to_localpart: 'nobody', attachments: [{ filename: 'a.pdf', content_type: 'x', size: 1 }] });
  expect(res.status).toBe(200);
  expect(res.body.recipient).toBe('unknown');
  expect(res.body.uploads ?? []).toHaveLength(0);
});

it('prepare: 密钥错回 401', async () => {
  const app = makeApp({}, true, true);
  const res = await request(app).post('/api/email/inbound/prepare')
    .set('Authorization', 'Basic ' + Buffer.from('cf:wrong').toString('base64'))
    .send({ to_localpart: 'sunco', attachments: [] });
  expect(res.status).toBe(401);
});
```

- [ ] **Step 4: 实现 prepare 路由**

在 inbound handler 之后加:

```typescript
  // ---- 入站附件 prepare: 查收件人归属, 已知则为每附件签 write-SAS ----
  router.post('/api/email/inbound/prepare', async (req: Request, res: Response) => {
    if (!checkInboundAuth(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const att = deps.attachments;
    if (!att) { res.status(501).json({ error: 'attachments not configured' }); return; }

    const body = (req.body ?? {}) as { to_localpart?: string; attachments?: Array<{ filename?: string; content_type?: string; size?: number }> };
    const localpart = String(body.to_localpart ?? '').trim().toLowerCase();
    const list = Array.isArray(body.attachments) ? body.attachments : [];
    if (!localpart) { res.status(400).json({ error: 'to_localpart required' }); return; }

    try {
      const userId = await dao.findUserByLocalpart(localpart);
      if (!userId) {
        log.warn({ event: 'email.inbound.drop', reason: 'unknown_recipient', to_localpart: localpart, phase: 'prepare' });
        res.status(200).json({ recipient: 'unknown' });
        return;
      }
      const udk = await att.udkCache.get();
      const uploads = list.map((a, idx) => {
        const safe = safeFilename(a.filename) || `attachment-${idx}`;
        const key = `${randomUUID()}-${safe}`;
        const sas = buildWriteBlobSas({
          account: att.accountName, container: att.container, blobName: key,
          udk, ttlSeconds: att.writeSasTtlSeconds,
        });
        const url = `${att.blobEndpoint}/${att.container}/${key.split('/').map(encodeURIComponent).join('/')}?${sas.sasToken}`;
        return { idx, key, sas_url: url };
      });
      res.status(200).json({ recipient: 'ok', uploads });
    } catch (err) {
      res.status(500).json({ error: 'internal', message: String(err) });
    }
  });
```

在文件底部(`buildEmailRouter` 外)加 `safeFilename`:

```typescript
function safeFilename(name: string | undefined): string {
  const base = (name ?? '').replace(/[/\\]/g, '_').replace(/[\x00-\x1f]/g, '').trim();
  return base.slice(0, 200);
}
```

- [ ] **Step 5: makeApp 支持 attachments dep**

调整 `test/api/email.test.ts` 的 `makeApp`,加第三参 `withAttachments=false`,为 true 时给 `buildEmailRouter` 传:

```typescript
  attachments: withAttachments ? {
    udkCache: { get: vi.fn().mockResolvedValue({
      signedObjectId: '1', signedTenantId: '2',
      signedStartsOn: new Date(), signedExpiresOn: new Date(Date.now()+86400000),
      signedService: 'b', signedVersion: '2020-02-10',
      value: Buffer.from('k').toString('base64'),
    }) },
    accountName: 'stlingxilaifu', container: 'email-attachments',
    blobEndpoint: 'https://stlingxilaifu.blob.core.windows.net',
    writeSasTtlSeconds: 300, readSasTtlSeconds: 300,
  } : undefined,
```

- [ ] **Step 6: 跑测试**

Run: `cd apps/gateway && pnpm vitest run test/api/email.test.ts`
Expected: PASS(含新 3 例 + 旧例不回归)。

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/src/api/email.ts apps/gateway/test/api/email.test.ts
git commit -m "feat(email): 新增 /api/email/inbound/prepare(查收件人+签 write-SAS)"
```

---

## Task 6: commit 落 attachment_keys(回归确认)

**Files:**
- Test: `apps/gateway/test/api/email.test.ts`

commit 路径无需改代码——inbound handler 已 `dao.insertInbound(parsed, userId)`,而 Task 4 让 `parseInbound` 产出 `attachment_keys`、Task 3 让 `insertInbound` 落库。本 Task 仅加回归测试钉死。

- [ ] **Step 1: 加测试**

```typescript
it('inbound commit: attachment_keys 透传到 insertInbound', async () => {
  const insertInbound = vi.fn().mockResolvedValue('eml_1');
  const app = makeApp({ insertInbound });
  await request(app).post('/api/email/inbound')
    .set('Authorization', 'Basic ' + Buffer.from('cf:' + SECRET).toString('base64'))
    .send({ to: 'sunco@laifu.uncagedai.org', from_addr: 'b@x', subject: 's', text: 't',
      attachment_keys: [{ key: '01J-a.pdf', filename: 'a.pdf', content_type: 'application/pdf', size: 9 }] });
  expect(insertInbound).toHaveBeenCalled();
  const parsedArg = insertInbound.mock.calls[0][0];
  expect(parsedArg.attachment_keys).toHaveLength(1);
  expect(parsedArg.has_attachments).toBe(true);
});
```

- [ ] **Step 2: 跑测试**

Run: `cd apps/gateway && pnpm vitest run test/api/email.test.ts`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add apps/gateway/test/api/email.test.ts
git commit -m "test(email): commit 落 attachment_keys 回归"
```

---

## Task 7: gateway 新增附件下载端点

**Files:**
- Modify: `apps/gateway/src/api/email.ts`(新 `GET /api/email/attachment`)
- Test: `apps/gateway/test/api/email.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
it('attachment 下载: 校验属主 + 签 read-SAS 302', async () => {
  const get = vi.fn().mockResolvedValue({
    id: 'eml_1', user_id: USER_ID, direction: 'inbound',
    attachment_keys: [{ key: '01J-a.pdf', filename: 'a.pdf', content_type: 'application/pdf', size: 9 }],
  });
  const app = makeApp({ get }, true, true);
  const res = await request(app).get('/api/email/attachment?id=eml_1&idx=0'); // fakeContainerAuth 已塞 user_id
  expect(res.status).toBe(302);
  expect(res.headers.location).toContain('email-attachments/01J-a.pdf');
  expect(res.headers.location).toMatch(/sig=/);
});

it('attachment 下载: idx 越界 404', async () => {
  const get = vi.fn().mockResolvedValue({ id: 'eml_1', user_id: USER_ID, attachment_keys: [] });
  const app = makeApp({ get }, true, true);
  const res = await request(app).get('/api/email/attachment?id=eml_1&idx=5');
  expect(res.status).toBe(404);
});
```

(注:`makeApp` 的 `get` mock 现有返回需补 `attachment_keys` 字段;`fakeContainerAuth` 已注入 `req.user_id=USER_ID`。`dao.get(userId,id)` 本身已做属主过滤,故他人邮件返回 null → 404。)

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/gateway && pnpm vitest run test/api/email.test.ts`
Expected: FAIL — 路由不存在(404 文案不符 / location 缺失)。

- [ ] **Step 3: 实现路由**

在 `/api/email/get` 路由附近(containerAuth 组里)加:

```typescript
  router.get('/api/email/attachment', deps.containerAuth, deps.requireEmailEntitlement,
    async (req: Request, res: Response) => {
      const att = deps.attachments;
      if (!att) { res.status(501).json({ error: 'attachments not configured' }); return; }
      const userId = req.user_id!;
      const id = String(req.query['id'] ?? '');
      const idx = parseInt(String(req.query['idx'] ?? ''), 10);
      if (!id || !Number.isInteger(idx) || idx < 0) { res.status(400).json({ error: 'id + idx required' }); return; }
      try {
        const email = await dao.get(userId, id);   // 已按 user_id 过滤
        const ref: AttachmentRef | undefined = email?.attachment_keys?.[idx];
        if (!ref) { res.status(404).json({ error: 'attachment not found' }); return; }
        const udk = await att.udkCache.get();
        const sas = buildReadBlobSas({
          account: att.accountName, container: att.container, blobName: ref.key,
          udk, ttlSeconds: att.readSasTtlSeconds,
          contentDisposition: buildContentDisposition('attachment', ref.filename),
        });
        const encoded = ref.key.split('/').map(encodeURIComponent).join('/');
        res.redirect(302, `${att.blobEndpoint}/${att.container}/${encoded}?${sas.sasToken}`);
      } catch (err) {
        res.status(500).json({ error: 'internal', message: String(err) });
      }
    });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/gateway && pnpm vitest run test/api/email.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/api/email.ts apps/gateway/test/api/email.test.ts
git commit -m "feat(email): 新增 /api/email/attachment 下载(read-SAS 302)"
```

---

## Task 8: config + index.ts 注入 blob 依赖到 email router

**Files:**
- Modify: `apps/gateway/src/config.ts:88-100`(email 段)
- Modify: `apps/gateway/.env.example`(邮件段)
- Modify: `apps/gateway/src/index.ts:250-314`(上移 blob client 构造,注入 email router)

- [ ] **Step 1: config 加 attachmentContainer**

`config.ts` 的 `email:` 块里,`resendApiKey` 之后加:

```typescript
    // 附件专用 Blob 容器(与云盘 laifu-cloud 分开)
    attachmentContainer: process.env['EMAIL_ATTACHMENT_CONTAINER'] ?? 'email-attachments',
```

`.env.example` 的 `RESEND_API_KEY=` 之后加:

```bash
# 入站附件专用 Blob 容器(与云盘分开;prod 由 bicep 建)
EMAIL_ATTACHMENT_CONTAINER=email-attachments
```

- [ ] **Step 2: index.ts 上移 blob client 构造**

把 `if (config.azure.storageAccount && config.cloud.blobEndpoint) { const blobServiceClient=...; const udkCache=...;` 这两行的构造**上移到 email router 块之前**,放进一个共享变量:

在 `// 邮件能力 (B1)` 块**之前**加:

```typescript
    // Blob 依赖(云盘 + 邮件附件共用)。无 Azure 配置时为 null,附件相关端点回 501。
    const blobDeps = (config.azure.storageAccount && config.cloud.blobEndpoint)
      ? {
          blobServiceClient: getBlobServiceClient({ accountName: config.azure.storageAccount, blobEndpoint: config.cloud.blobEndpoint }),
          udkCache: getUserDelegationKeyCache({ accountName: config.azure.storageAccount, blobEndpoint: config.cloud.blobEndpoint, udkLifetimeSeconds: config.cloud.udkLifetimeSeconds }),
        }
      : null;
```

email router 的 `buildEmailRouter({...})` 加 `attachments`:

```typescript
        attachments: blobDeps ? {
          udkCache: blobDeps.udkCache,
          accountName: config.azure.storageAccount,
          container: config.email.attachmentContainer,
          blobEndpoint: config.cloud.blobEndpoint,
          writeSasTtlSeconds: config.cloud.writeSasTtlSeconds,
          readSasTtlSeconds: config.cloud.readSasTtlSeconds,
        } : undefined,
```

把后面 cloud router 块里**重复构造** `blobServiceClient`/`udkCache` 的两行删掉,改用 `blobDeps`(整个 cloud `if` 块改成 `if (blobDeps) { app.use(buildCloudRouter({ ... blobServiceClient: blobDeps.blobServiceClient, udkCache: blobDeps.udkCache, ... })) }`)。

- [ ] **Step 3: 确保 email-attachments 容器存在(dev 兜底)**

在 `blobDeps` 构造后加(仅当有 blobDeps):

```typescript
    if (blobDeps) {
      await blobDeps.blobServiceClient.getContainerClient(config.email.attachmentContainer).createIfNotExists();
    }
```

(`start()` 已是 async;若该上下文非 async,用 `.catch(()=>{})` 包一下,失败不致命——prod 由 bicep 建。)

- [ ] **Step 4: typecheck + 全量邮件测试**

Run: `cd apps/gateway && npx tsc --noEmit && pnpm vitest run test/api/email.test.ts test/lib/email test/lib/sas-builder.test.ts`
Expected: tsc 0;测试 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/config.ts apps/gateway/.env.example apps/gateway/src/index.ts
git commit -m "feat(email): 注入附件 Blob 依赖到 email router + EMAIL_ATTACHMENT_CONTAINER"
```

---

## Task 9: bicep 加 email-attachments 容器 + appSetting

**Files:**
- Modify: `infra/bicep/main.bicep`(`cloudContainer` 资源旁 + appSettings 邮件段)

- [ ] **Step 1: 加容器资源**

在 `resource cloudContainer ... name: 'laifu-cloud' ...}` 之后加:

```bicep
resource emailAttachmentContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'email-attachments'
  properties: { publicAccess: 'None' }
}
```

- [ ] **Step 2: 加 appSetting**

appSettings 邮件段(`RESEND_API_KEY` 那行附近)加:

```bicep
    EMAIL_ATTACHMENT_CONTAINER: 'email-attachments'
```

- [ ] **Step 3: 校验 bicep 语法**

Run: `cd infra/bicep && az bicep build --file main.bicep --stdout > /dev/null && echo OK`
Expected: `OK`(无 az 环境则跳过,人工核对缩进)。

- [ ] **Step 4: Commit**

```bash
git add infra/bicep/main.bicep
git commit -m "feat(email): bicep 加 email-attachments 容器 + appSetting"
```

---

## Task 10: CF Worker prepare→PUT→commit + setReject

**Files:**
- Modify: `infra/cloudflare-email-worker/src/index.ts`

- [ ] **Step 1: 改 email handler**

把 `email()` handler 改为(保留无附件直发 commit 的兼容路径):

```typescript
import PostalMime from 'postal-mime';

interface Env { GATEWAY_URL: string; INBOUND_WEBHOOK_SECRET: string; }

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    try {
      const email = await PostalMime.parse(message.raw);
      const auth = 'Basic ' + btoa(`cf:${env.INBOUND_WEBHOOK_SECRET}`);
      const base = env.GATEWAY_URL;
      const toLocalpart = (message.to.split('@')[0] || '').toLowerCase();
      const atts = email.attachments ?? [];

      let attachmentKeys: Array<{ key: string; filename: string; content_type: string; size: number }> = [];

      if (atts.length > 0) {
        // 1. prepare
        const prep = await fetch(`${base}/api/email/inbound/prepare`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: auth },
          body: JSON.stringify({
            to_localpart: toLocalpart,
            attachments: atts.map((a) => ({
              filename: a.filename ?? 'attachment',
              content_type: a.mimeType ?? 'application/octet-stream',
              size: (a.content as ArrayBuffer).byteLength,
            })),
          }),
        });
        if (!prep.ok) throw new Error(`prepare ${prep.status}`);
        const pj = await prep.json() as { recipient: string; uploads?: Array<{ idx: number; key: string; sas_url: string }> };
        if (pj.recipient === 'unknown') {
          console.log(`[email-worker] drop unknown recipient ${message.to}`);
          return; // 未知收件人:丢弃,不上传不 commit
        }
        // 2. 上传每个附件
        for (const u of pj.uploads ?? []) {
          const a = atts[u.idx]!;
          const put = await fetch(u.sas_url, {
            method: 'PUT',
            headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': a.mimeType ?? 'application/octet-stream' },
            body: a.content as ArrayBuffer,
          });
          if (!put.ok) throw new Error(`blob PUT ${put.status}`);
          attachmentKeys.push({
            key: u.key, filename: a.filename ?? 'attachment',
            content_type: a.mimeType ?? 'application/octet-stream',
            size: (a.content as ArrayBuffer).byteLength,
          });
        }
      }

      // 3. commit
      const refs = (email.references ?? '').split(/\s+/).map((s) => s.trim()).filter(Boolean);
      const payload = {
        to: message.to,
        from_addr: email.from?.address ?? message.from,
        to_addrs: (email.to ?? []).map((a) => a.address).filter(Boolean),
        cc_addrs: (email.cc ?? []).map((a) => a.address).filter(Boolean),
        subject: email.subject ?? '',
        message_id: email.messageId ?? null,
        in_reply_to: email.inReplyTo ?? null,
        reference_ids: refs,
        text: email.text ?? '',
        attachment_keys: attachmentKeys,
      };
      const resp = await fetch(`${base}/api/email/inbound`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify(payload),
      });
      if (!resp.ok && resp.status !== 202) throw new Error(`commit ${resp.status}`);
    } catch (err) {
      console.error(`[email-worker] failed for ${message.to}: ${err}`);
      message.setReject('temporary failure, please retry'); // 让发件方 MTA 重投
    }
  },
};
```

- [ ] **Step 2: dry-run 验证打包**

Run: `cd infra/cloudflare-email-worker && npm install && npx wrangler deploy --dry-run --outdir=/tmp/ew`
Expected: `Total Upload: ...`,无打包错误。

- [ ] **Step 3: 本地联调(需本地 gateway:9000 + .dev.vars)**

```bash
cp .dev.vars.example .dev.vars   # GATEWAY_URL=http://localhost:9000
npx wrangler dev
# 另开终端用 wrangler 触发带附件的测试 email 事件,观察 prepare/PUT/commit 日志
```
Expected:日志见 prepare→PUT→commit;gateway 落库 `attachment_keys` 非空。

- [ ] **Step 4: Commit**

```bash
git add infra/cloudflare-email-worker/src/index.ts infra/cloudflare-email-worker/package-lock.json
git commit -m "feat(email): Worker prepare→PUT→commit 上传附件 + 失败 setReject"
```

---

## Task 11: 更新 Worker 文档(交接部署 + owner)

**Files:**
- Modify: `infra/cloudflare-email-worker/README.md`(§"这个 Worker 干什么" + §4 自检)
- Modify: `infra/cloudflare-email-worker/OWNER-NOTES.md`(加 email-attachments 容器前置 + 附件 webhook 契约)

- [ ] **Step 1: README "干什么" 段更新**

把 README 的 "这个 Worker 干什么" 段改为反映新流程:

```markdown
## 这个 Worker 干什么

`laifu.uncagedai.org` 收到的邮件 → Email Routing catch-all 投给本 Worker → postal-mime 解析:
- **有附件**:先 `POST {GATEWAY_URL}/api/email/inbound/prepare` 拿每个附件的 write-SAS → 直接 PUT 到 Azure Blob → 再 `POST {GATEWAY_URL}/api/email/inbound`(commit)带 attachment_keys 落库。
- **无附件**:直接 commit。
- 任一步失败 → `message.setReject()` 让发件方 MTA 重投(不丢信)。

部署方式不变(`wrangler deploy`);**不需要给 Worker 任何 Azure 凭据**——写 SAS 由 gateway 签发。
```

README §4 自检补一句:带附件的测试邮件应在 `wrangler tail` 看到 prepare + 多次 PUT + commit。

- [ ] **Step 2: OWNER-NOTES 加附件前置 + 契约**

在 `OWNER-NOTES.md` 加一节:

```markdown
## 入站附件(项目方前置)

- **新建 Blob 容器 `email-attachments`**(与云盘 `laifu-cloud` 分开):prod 由 bicep 建(已加资源);dev gateway 启动时 `createIfNotExists` 兜底,或手建一次。
- gateway 需 `EMAIL_ATTACHMENT_CONTAINER=email-attachments`(三处守则已加;dev `.env.local` 默认值即可)。
- gateway 系统身份已有 `Storage Blob Data Owner` → 能签 write/read SAS,无需额外授权。
- 建议给 `email-attachments` 容器挂 lifecycle 规则(按创建 N 天删),清理"上传成功但 commit 失败"的孤儿 blob。
- 附件 webhook 契约:prepare `{to_localpart, attachments:[{filename,content_type,size}]}` → `{recipient, uploads:[{idx,key,sas_url}]}`;commit body 增加 `attachment_keys:[{key,filename,content_type,size}]`。
```

- [ ] **Step 3: Commit**

```bash
git add infra/cloudflare-email-worker/README.md infra/cloudflare-email-worker/OWNER-NOTES.md
git commit -m "docs(email): Worker README/OWNER-NOTES 补入站附件流程 + 容器前置"
```

---

## Task 12: 端到端验证 + 收尾

- [ ] **Step 1: 全量 gateway 测试 + typecheck**

Run: `cd apps/gateway && npx tsc --noEmit && pnpm vitest run`
Expected: tsc 0;全绿。

- [ ] **Step 2: 真端到端(部署 Worker + 配置就绪后)**

从 Gmail 发一封**带 PDF 附件**的邮件到 `sunco@laifu.uncagedai.org`:
- DB `emails` 行 `has_attachments=true`、`attachment_keys` 有项(查:`select attachment_keys from emails order by received_at desc limit 1;`)。
- `GET /api/email/attachment?id=<id>&idx=0`(带容器 token)302 跳到 Blob,能下到原 PDF。

- [ ] **Step 3: 推分支 + 起 PR**

```bash
git push -u origin feat/email-inbound-attachments
gh pr create --base main --title "feat(email): 入站附件落 Blob + 可下载" --body "实现 docs/superpowers/specs/2026-06-12-inbound-email-attachments-design.md。方案 B:Worker prepare→PUT→commit,附件存 email-attachments 容器(与 email_id/uid 解耦),下载签 read-SAS。"
```

---

## 自检(spec 覆盖)

- prepare 查收件人→签 write-SAS、未知不签 → Task 5 ✅
- commit 写 attachment_keys → Task 3/4/6 ✅
- 下载签 read-SAS → Task 7 ✅
- 专用容器 email-attachments(bicep+config+createIfNotExists)→ Task 8/9 ✅
- key=`${attId}-${safe_filename}`、与 uid/email_id 解耦 → Task 5(randomUUID + safeFilename)✅
- Worker prepare→PUT→commit + setReject → Task 10 ✅
- Worker 文档(交接部署)→ Task 11 ✅
- 出站/容器CLI/raw eml 不在本次 → 未建任务 ✅
