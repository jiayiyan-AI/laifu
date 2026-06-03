# Cloud Drive — P2 Data Plane Gateway Routes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把云盘的**数据面**接通 —— gateway 暴露三个 HTTP 路由（`/api/cloud/sas`、`/api/cloud/list`、`/api/cloud/download`），让容器（P3 cloud-publish）能拿写 SAS、让 web（P4-P6 Files App）能列文件 + 下载/预览文件。

**Architecture:**
- **数据面 vs 控制面**：spec §二图示 —— gateway 退到"签 SAS、列 metadata、签 read SAS"的控制面角色，文件二进制流不经 gateway（容器直接 PUT Blob、浏览器直接 GET Blob via SAS）
- **复用 P0 已有零件**：`buildDirectoryWriteSas`（hand-signed sr=d sdd=1）+ `UserDelegationKeyCache` + `validateVirtualPath` 直接拿来用
- **新增零件**：
  - `blob-service-client.ts` — 工厂返回 `BlobServiceClient`（DefaultAzureCredential），同时 wire `UDK` cache 的 fetcher
  - `content-disposition.ts` — RFC 5987 编码中文文件名
  - `buildReadBlobSas` —— 单 blob 读 SAS（`sr=b`），**用 Azure SDK 的 `generateBlobSASQueryParameters`**（SDK 原生支持 sr=b，不需要 hand-sign）
- **三个路由**：用 P1 已有的 `requireSession` (web) 或 `makeContainerTokenMiddleware` (容器) 做鉴权；entitlement 检查放 middleware 层兜底

**Tech Stack:**
- 复用 P0/P1 全栈：Node.js 24 / TypeScript / Express / vitest / `@azure/storage-blob@^12.20.0` / `@azure/identity@^4.0.0`
- 不需新依赖

**Out of scope for P2:**
- `cloud-publish` Hermes skill（容器侧 CLI）→ P3
- Files App / ManageApp UI → P4-P6
- Web 上传 / 删除 / 重命名 → 第二迭代（spec §七列出过）
- 配额 / 审计 / rate limiting → 未来

**Spec reference:** `docs/superpowers/specs/2026-06-01-cloud-drive-design.md` §五（API 详细规格 + 错误码表）+ §十（P2 段验证标准）+ §十一（Azurite directory SAS 风险已知）

---

## File Structure (P2 范围)

```
新增 — gateway lib:
  apps/gateway/src/lib/blob-service-client.ts                  工厂：DefaultAzureCredential → BlobServiceClient + UDK cache fetcher 注入
  apps/gateway/test/lib/blob-service-client.test.ts            最小单测（类型 + cache 复用）
  apps/gateway/src/lib/content-disposition.ts                  RFC 5987 编码（attachment + filename*）
  apps/gateway/test/lib/content-disposition.test.ts            ASCII / 中文 / 特殊字符
  (扩展) apps/gateway/src/lib/sas-builder.ts                   + buildReadBlobSas (用 SDK，sr=b，可带 rscd)
  (扩展) apps/gateway/test/lib/sas-builder.test.ts             + buildReadBlobSas 测试

新增 — gateway API 路由:
  apps/gateway/src/api/cloud.ts                                 三个端点：/api/cloud/{sas,list,download}
  apps/gateway/test/api/cloud.test.ts                           覆盖三端点 + entitlement 拒、多租户隔离、dispose 行为

修改:
  apps/gateway/src/index.ts                                     + 注册 cloud router；从 P1 已有的 DAO/blob-service-client/sessionMw/containerAuth 拉依赖
  (扩展) packages/shared/src/contracts.ts                       + CloudListResponse / CloudFileItem / CloudFolderItem types

不动:
  - P0/P1 已建的所有：sas-builder.buildDirectoryWriteSas, UserDelegationKeyCache, validateVirtualPath, container-token middleware, requireSession, entitlements DAO, etc.
```

每个 src 文件单一职责：

| 文件 | 职责 |
|---|---|
| `blob-service-client.ts` | 工厂：构造 `BlobServiceClient`（DefaultAzureCredential，缓存单例） + 构造 `UserDelegationKeyCache`（fetcher = `client.getUserDelegationKey`）。两者一起注入路由。 |
| `content-disposition.ts` | 纯函数：`buildContentDisposition(disposition, filename) → string`。处理 ASCII fast path + 中文 RFC 5987 编码。 |
| `sas-builder.ts`（已有）+ `buildReadBlobSas` | 用 Azure SDK 的 `generateBlobSASQueryParameters`（sr=b + sp=r + 可选 rscd），返回 `{ sasToken, expiresAt }` |
| `cloud.ts` | 三个路由handler：sas / list / download，使用 lib + DAO + middleware 拼装 |

---

## Task 0: 起步检查

**Files:** 无

- [ ] **Step 1: 分支 + 工作树干净**

Run: `git status && git branch --show-current`
Expected: on `feat/cloud-drive`, tree clean.

- [ ] **Step 2: P0 + P1 都在**

Run: `git log --oneline main..HEAD | head -5`
Expected: 最新 commit 是 `85a4b68 feat(hermes): entrypoint pulls entitlements ...`

- [ ] **Step 3: 测试 baseline**

Run: `pnpm --filter @lingxi/gateway test 2>&1 | tail -5`
Expected: 195 total（181 passed + 14 skipped DAO tests）。

- [ ] **Step 4: Supabase 在跑**

Run: `supabase status --workdir /Users/yanjiayi/workspace/laifu/infra 2>&1 | head -5`
Expected: db / api / studio running.

---

## Task 1: `blob-service-client` factory

**Files:**
- Create: `apps/gateway/src/lib/blob-service-client.ts`
- Create: `apps/gateway/test/lib/blob-service-client.test.ts`

工厂提供两个东西：
- `getBlobServiceClient()` — 缓存单例的 `BlobServiceClient`（用 `DefaultAzureCredential` 认证）
- `getUserDelegationKeyCache()` — 缓存单例的 `UserDelegationKeyCache`，fetcher 调上面的 client

单例避免每次请求重新构造（Azure SDK client 比较重）。

- [ ] **Step 1: 写测试**

Create `apps/gateway/test/lib/blob-service-client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resetBlobServiceClient, getBlobServiceClient, getUserDelegationKeyCache } from '../../src/lib/blob-service-client.js';

describe('blob-service-client factory', () => {
  beforeEach(() => {
    resetBlobServiceClient();
  });

  it('returns the same BlobServiceClient instance on repeated calls (singleton)', () => {
    // 用最小有效配置避免去真正连 Azure
    const a = getBlobServiceClient({ accountName: 'fakeacct', blobEndpoint: 'https://fakeacct.blob.core.windows.net' });
    const b = getBlobServiceClient({ accountName: 'fakeacct', blobEndpoint: 'https://fakeacct.blob.core.windows.net' });
    expect(a).toBe(b);
  });

  it('returns the same UserDelegationKeyCache instance on repeated calls', () => {
    const a = getUserDelegationKeyCache({ accountName: 'fakeacct', blobEndpoint: 'https://fakeacct.blob.core.windows.net', udkLifetimeSeconds: 7 * 24 * 3600 });
    const b = getUserDelegationKeyCache({ accountName: 'fakeacct', blobEndpoint: 'https://fakeacct.blob.core.windows.net', udkLifetimeSeconds: 7 * 24 * 3600 });
    expect(a).toBe(b);
  });

  it('resetBlobServiceClient clears the singleton so a new instance can be made', () => {
    const a = getBlobServiceClient({ accountName: 'fakeacct', blobEndpoint: 'https://fakeacct.blob.core.windows.net' });
    resetBlobServiceClient();
    const b = getBlobServiceClient({ accountName: 'fakeacct', blobEndpoint: 'https://fakeacct.blob.core.windows.net' });
    expect(a).not.toBe(b);
  });
});
```

Run: `pnpm --filter @lingxi/gateway test -- blob-service-client`
Expected: module not found.

- [ ] **Step 2: 实现**

Create `apps/gateway/src/lib/blob-service-client.ts`:

```typescript
import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { UserDelegationKeyCache } from './user-delegation-key-cache.js';

export interface BlobServiceClientConfig {
  accountName: string;        // e.g. 'stlingxidev'
  blobEndpoint: string;       // e.g. 'https://stlingxidev.blob.core.windows.net'
}

export interface UdkCacheConfig extends BlobServiceClientConfig {
  udkLifetimeSeconds: number;
}

let _blobClient: BlobServiceClient | null = null;
let _udkCache: UserDelegationKeyCache | null = null;

/**
 * Returns the singleton BlobServiceClient. Constructs on first call using
 * DefaultAzureCredential (works locally via az login, in ACA via Managed Identity).
 */
export function getBlobServiceClient(cfg: BlobServiceClientConfig): BlobServiceClient {
  if (!_blobClient) {
    const credential = new DefaultAzureCredential();
    _blobClient = new BlobServiceClient(cfg.blobEndpoint, credential);
  }
  return _blobClient;
}

/**
 * Returns the singleton UserDelegationKeyCache that knows how to fetch a fresh
 * UDK from the BlobServiceClient. The cache logic itself (TTL, refresh window)
 * lives in user-delegation-key-cache.ts.
 */
export function getUserDelegationKeyCache(cfg: UdkCacheConfig): UserDelegationKeyCache {
  if (!_udkCache) {
    const client = getBlobServiceClient(cfg);
    _udkCache = new UserDelegationKeyCache({
      fetcher: async () => {
        const start = new Date(Date.now() - 60 * 1000);
        const expiry = new Date(Date.now() + cfg.udkLifetimeSeconds * 1000);
        return client.getUserDelegationKey(start, expiry);
      },
      refreshWithinSeconds: 3600, // refresh when <1h remaining
    });
  }
  return _udkCache;
}

/** Test helper: clear the singletons so each test gets fresh state. */
export function resetBlobServiceClient(): void {
  _blobClient = null;
  _udkCache = null;
}
```

- [ ] **Step 3: Run + lint + commit**

```bash
pnpm --filter @lingxi/gateway test -- blob-service-client
pnpm --filter @lingxi/gateway test
pnpm --filter @lingxi/gateway run lint
git add apps/gateway/src/lib/blob-service-client.ts apps/gateway/test/lib/blob-service-client.test.ts
git commit -m "feat(gateway): blob-service-client factory + UDK cache wiring"
```

Expected: 3 new tests pass; full suite 198+ (195 + 3 new); lint clean.

---

## Task 2: `content-disposition` lib

**Files:**
- Create: `apps/gateway/src/lib/content-disposition.ts`
- Create: `apps/gateway/test/lib/content-disposition.test.ts`

按 RFC 5987 编码 `Content-Disposition` header 的 filename。规则：
- ASCII 文件名（无空格、无特殊字符）→ `attachment; filename="x.pdf"`
- 含非 ASCII / 空格 / 特殊字符 → `attachment; filename*=UTF-8''<percent-encoded>`
- 同时提供 ASCII fallback（兼容老 UA）：`attachment; filename="<ascii-fallback>"; filename*=UTF-8''<...>`

- [ ] **Step 1: 写测试**

Create `apps/gateway/test/lib/content-disposition.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildContentDisposition } from '../../src/lib/content-disposition.js';

describe('buildContentDisposition', () => {
  describe('disposition type', () => {
    it('uses attachment when type=attachment', () => {
      expect(buildContentDisposition('attachment', 'a.pdf')).toMatch(/^attachment;/);
    });

    it('uses inline when type=inline', () => {
      expect(buildContentDisposition('inline', 'a.pdf')).toMatch(/^inline;/);
    });
  });

  describe('ASCII filename', () => {
    it('uses plain quoted form for simple ASCII names', () => {
      const r = buildContentDisposition('attachment', 'report.pdf');
      expect(r).toBe('attachment; filename="report.pdf"');
    });

    it('keeps simple ASCII names with dots/dashes/underscores', () => {
      const r = buildContentDisposition('attachment', 'q2-sales_2026.pdf');
      expect(r).toBe('attachment; filename="q2-sales_2026.pdf"');
    });
  });

  describe('non-ASCII filename (Chinese, emoji)', () => {
    it('encodes Chinese with filename*=UTF-8 RFC 5987', () => {
      const r = buildContentDisposition('attachment', '销售报告.pdf');
      expect(r).toMatch(/filename\*=UTF-8''/);
      // 完整编码: %E9%94%80%E5%94%AE%E6%8A%A5%E5%91%8A.pdf
      expect(r).toContain('%E9%94%80%E5%94%AE%E6%8A%A5%E5%91%8A.pdf');
    });

    it('includes ASCII fallback alongside the encoded form', () => {
      const r = buildContentDisposition('attachment', '销售报告.pdf');
      // Should have both filename="..." (ASCII fallback) and filename*=UTF-8''...
      expect(r).toMatch(/filename="[^"]*\.pdf"/);
      expect(r).toMatch(/filename\*=UTF-8''/);
    });

    it('encodes emoji', () => {
      const r = buildContentDisposition('attachment', '🎉party.png');
      expect(r).toMatch(/filename\*=UTF-8''/);
      expect(r).toContain('%F0%9F%8E%89');
    });
  });

  describe('special characters', () => {
    it('encodes spaces (which are not allowed in unquoted token form)', () => {
      const r = buildContentDisposition('attachment', 'my report.pdf');
      // either quoted ASCII fallback, or encoded
      expect(r).toMatch(/filename="my report\.pdf"|filename\*=UTF-8''my%20report\.pdf/);
    });

    it('encodes quotes and backslashes safely', () => {
      const r = buildContentDisposition('attachment', 'a"b\\c.txt');
      expect(r).toMatch(/filename\*=UTF-8''/);
      // The result should not contain raw " or \ in the filename* parameter
    });
  });

  describe('edge cases', () => {
    it('handles empty filename by using a generic name', () => {
      const r = buildContentDisposition('attachment', '');
      expect(r).toMatch(/filename="(file|download)"/i);
    });
  });
});
```

Run: `pnpm --filter @lingxi/gateway test -- content-disposition`
Expected: module not found.

- [ ] **Step 2: 实现**

Create `apps/gateway/src/lib/content-disposition.ts`:

```typescript
/**
 * Build a Content-Disposition header value.
 *
 * RFC 6266 + RFC 5987:
 *   - Simple ASCII filenames (no spaces/quotes/special) → plain quoted form
 *   - Non-ASCII / spaces / special → filename*=UTF-8'' percent-encoded,
 *     with an ASCII fallback (filename="...") for legacy UAs
 *
 * @param disposition 'attachment' | 'inline'
 * @param filename The intended filename (UTF-8 string; may contain Chinese, emoji, etc.)
 */
export function buildContentDisposition(
  disposition: 'attachment' | 'inline',
  filename: string,
): string {
  const name = filename.length > 0 ? filename : 'download';

  // Simple ASCII fast path: only safe chars (letters, digits, ._-)
  if (/^[\x20-\x7E]+$/.test(name) && !/["\\]/.test(name)) {
    // Plain quoted form; spaces are allowed inside quotes per RFC 6266
    return `${disposition}; filename="${name}"`;
  }

  // RFC 5987: encode as UTF-8 + percent-escape
  const encoded = encodeRFC5987(name);

  // Build ASCII fallback by stripping non-ASCII and replacing unsafe chars
  const fallback = name
    .replace(/[^\x20-\x7E]/g, '_')   // non-ASCII → _
    .replace(/["\\]/g, '_');          // " and \ unsafe in quoted form

  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * RFC 5987 encoding: percent-escape everything except attr-char
 * (ALPHA / DIGIT / "!" / "#" / "$" / "&" / "+" / "-" / "." / "^" / "_" / "`" / "|" / "~")
 */
function encodeRFC5987(s: string): string {
  // encodeURIComponent over-escapes (e.g. '!' is safe per 5987 but encoded by encodeURIComponent),
  // but it's safe to over-escape — UAs decode correctly. Simpler than custom impl.
  return encodeURIComponent(s)
    // encodeURIComponent leaves these unescaped, but RFC 5987 requires them escaped:
    .replace(/['()]/g, escape)
    .replace(/\*/g, '%2A');
}
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @lingxi/gateway test -- content-disposition
pnpm --filter @lingxi/gateway test
pnpm --filter @lingxi/gateway run lint
git add apps/gateway/src/lib/content-disposition.ts apps/gateway/test/lib/content-disposition.test.ts
git commit -m "feat(gateway): RFC 5987 Content-Disposition encoder for non-ASCII filenames"
```

Expected: 9 new tests pass; full suite 207+; lint clean.

---

## Task 3: `buildReadBlobSas` (extend sas-builder)

**Files:**
- Modify: `apps/gateway/src/lib/sas-builder.ts`
- Modify: `apps/gateway/test/lib/sas-builder.test.ts`

加新 export `buildReadBlobSas` —— 用 Azure SDK 的 `generateBlobSASQueryParameters` 签 sr=b 单 blob 读 SAS。可选 `rscd`（Content-Disposition override）。

SDK 原生支持 sr=b（不像 sr=d 必须 hand-sign），所以这个函数比 `buildDirectoryWriteSas` 简洁很多。

- [ ] **Step 1: 在现有测试文件末尾追加 buildReadBlobSas 测试**

Append to `apps/gateway/test/lib/sas-builder.test.ts` (inside the existing `describe('buildDirectoryWriteSas', () => { ... })` block AFTER, NOT inside)：

```typescript

describe('buildReadBlobSas', () => {
  const ACCOUNT = 'stlingxidev';
  const CONTAINER = 'laifu-cloud';
  const BLOB_NAME = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/reports/q2.pdf';

  it('generates a blob-scoped read SAS (sr=b, sp=r)', () => {
    const { sasToken } = buildReadBlobSas({
      account: ACCOUNT,
      container: CONTAINER,
      blobName: BLOB_NAME,
      udk: fakeUdk(),
      ttlSeconds: 300,
    });
    const params = parseSas(sasToken);
    expect(params['sr']).toBe('b');
    expect(params['sp']).toBe('r');
  });

  it('includes spr=https and a sig', () => {
    const { sasToken } = buildReadBlobSas({
      account: ACCOUNT,
      container: CONTAINER,
      blobName: BLOB_NAME,
      udk: fakeUdk(),
      ttlSeconds: 300,
    });
    const params = parseSas(sasToken);
    expect(params['spr']).toBe('https');
    expect(params['sig']).toBeDefined();
  });

  it('omits rscd when contentDisposition not specified', () => {
    const { sasToken } = buildReadBlobSas({
      account: ACCOUNT,
      container: CONTAINER,
      blobName: BLOB_NAME,
      udk: fakeUdk(),
      ttlSeconds: 300,
    });
    const params = parseSas(sasToken);
    expect(params['rscd']).toBeUndefined();
  });

  it('includes rscd when contentDisposition specified', () => {
    const { sasToken } = buildReadBlobSas({
      account: ACCOUNT,
      container: CONTAINER,
      blobName: BLOB_NAME,
      udk: fakeUdk(),
      ttlSeconds: 300,
      contentDisposition: 'attachment; filename="x.pdf"',
    });
    const params = parseSas(sasToken);
    expect(params['rscd']).toBe('attachment; filename="x.pdf"');
  });

  it('returns expiresAt approximately now + ttlSeconds', () => {
    const before = Date.now();
    const { expiresAt } = buildReadBlobSas({
      account: ACCOUNT,
      container: CONTAINER,
      blobName: BLOB_NAME,
      udk: fakeUdk(),
      ttlSeconds: 300,
    });
    const after = Date.now();
    const ms = expiresAt.getTime();
    expect(ms).toBeGreaterThanOrEqual(before + 300_000 - 5000);
    expect(ms).toBeLessThanOrEqual(after + 300_000 + 5000);
  });
});
```

Make sure the existing `import { buildDirectoryWriteSas }` line is updated to also import `buildReadBlobSas`:

```typescript
import { buildDirectoryWriteSas, buildReadBlobSas } from '../../src/lib/sas-builder.js';
```

Run: `pnpm --filter @lingxi/gateway test -- sas-builder`
Expected: existing tests pass + new buildReadBlobSas tests fail (function not exported yet).

- [ ] **Step 2: Implement `buildReadBlobSas`**

In `apps/gateway/src/lib/sas-builder.ts`, append:

```typescript

// === Read SAS (sr=b, blob-scoped) — uses Azure SDK directly, no hand-signing needed ===

import {
  BlobSASPermissions,
  SASProtocol,
  UserDelegationKeyCredential,
  generateBlobSASQueryParameters,
} from '@azure/storage-blob';

export interface ReadBlobSasInput {
  account: string;
  container: string;
  blobName: string;             // full blob name (including <user_id>/<virtual_path>)
  udk: UserDelegationKey;
  ttlSeconds: number;
  contentDisposition?: string;  // optional: SAS rscd parameter (e.g. 'attachment; filename*=UTF-8''...')
}

export interface ReadBlobSasOutput {
  sasToken: string;
  expiresAt: Date;
}

/**
 * Build a blob-scoped read SAS using the Azure SDK. Unlike buildDirectoryWriteSas
 * (which hand-signs because SDK doesn't support sr=d), the read case uses sr=b
 * which is natively supported. The SDK handles the canonicalized resource + sig.
 */
export function buildReadBlobSas(input: ReadBlobSasInput): ReadBlobSasOutput {
  const startsOn = new Date(Date.now() - 60 * 1000);
  const expiresOn = new Date(Date.now() + input.ttlSeconds * 1000);

  const permissions = BlobSASPermissions.from({ read: true });
  const credential = new UserDelegationKeyCredential(input.account, input.udk);

  const sasQueryParams = generateBlobSASQueryParameters(
    {
      containerName: input.container,
      blobName: input.blobName,
      permissions,
      protocol: SASProtocol.Https,
      startsOn,
      expiresOn,
      version: '2020-02-10',
      contentDisposition: input.contentDisposition,  // SDK maps this to the `rscd` query param
    },
    credential,
  );

  return {
    sasToken: sasQueryParams.toString(),
    expiresAt: expiresOn,
  };
}
```

Note: the existing top-of-file already imports `UserDelegationKey` from `@azure/storage-blob`. If the new imports (`BlobSASPermissions`, `SASProtocol`, `UserDelegationKeyCredential`, `generateBlobSASQueryParameters`) collide with existing imports, **consolidate them at the top** instead of having a second `import` block in the middle. ESLint may complain about the second import block; if so, merge.

- [ ] **Step 3: Run + lint + commit**

```bash
pnpm --filter @lingxi/gateway test -- sas-builder
pnpm --filter @lingxi/gateway test
pnpm --filter @lingxi/gateway run lint
git add apps/gateway/src/lib/sas-builder.ts apps/gateway/test/lib/sas-builder.test.ts
git commit -m "feat(gateway): buildReadBlobSas (sr=b, optional rscd) for cloud download"
```

Expected: 5 new tests pass; full suite 212+; lint clean.

---

## Task 4: `/api/cloud/sas` route (TDD)

**Files:**
- Create: `apps/gateway/src/api/cloud.ts` (containing all 3 routes; this task adds the first one)
- Create: `apps/gateway/test/api/cloud.test.ts`

`GET /api/cloud/sas` — 容器拿写 SAS：
1. 容器 token middleware 验签 → 拿 user_id
2. entitlement 检查 must have `cloud`
3. UDK cache 拿 UDK
4. `buildDirectoryWriteSas({ account, container, userId, udk, ttlSeconds })`
5. 返回 `CloudWriteSasResponse`（P0 contracts 已有）

- [ ] **Step 1: 写第一组失败测试**

Create `apps/gateway/test/api/cloud.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { buildCloudRouter } from '../../src/api/cloud.js';
import { signLaifuUserToken } from '../../src/lib/gateway-token.js';
import type { RequestHandler } from 'express';

const SECRET = 'test-secret-1234567890';
const USER_ID = '6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f';
const ACCOUNT = 'stlingxidev';
const CONTAINER = 'laifu-cloud';
const BLOB_ENDPOINT = `https://${ACCOUNT}.blob.core.windows.net`;

function mockSession(): RequestHandler {
  return (req, _res, next) => { (req as any).session = { user_id: USER_ID }; next(); };
}

function fakeUdk() {
  const now = new Date();
  return {
    signedObjectId: '00000000-0000-0000-0000-000000000001',
    signedTenantId: '00000000-0000-0000-0000-000000000002',
    signedStartsOn: now.toISOString(),
    signedExpiresOn: new Date(now.getTime() + 7 * 24 * 3600 * 1000).toISOString(),
    signedService: 'b',
    signedVersion: '2020-02-10',
    value: Buffer.from('a'.repeat(32)).toString('base64'),
  };
}

function makeApp(opts: {
  listActive?: ReturnType<typeof vi.fn>;
  getTokenVersion?: ReturnType<typeof vi.fn>;
  getUdk?: ReturnType<typeof vi.fn>;
  listBlobsByHierarchy?: any;
  blobHeadResp?: any;
}) {
  const app = express();
  app.use(express.json());
  app.use(buildCloudRouter({
    secret: SECRET,
    config: { accountName: ACCOUNT, container: CONTAINER, blobEndpoint: BLOB_ENDPOINT, writeSasTtlSeconds: 900, readSasTtlSeconds: 300 },
    entitlements: {
      listActive: opts.listActive ?? vi.fn().mockResolvedValue(['cloud']),
      getTokenVersion: opts.getTokenVersion ?? vi.fn().mockResolvedValue(0),
    } as any,
    udkCache: { get: opts.getUdk ?? vi.fn().mockResolvedValue(fakeUdk()) } as any,
    blobServiceClient: {
      getContainerClient: () => ({
        listBlobsByHierarchy: opts.listBlobsByHierarchy ?? (() => emptyIterable()),
        getBlobClient: (name: string) => ({
          getProperties: () => opts.blobHeadResp ?? Promise.resolve({
            contentType: 'application/pdf',
            contentLength: 123,
            lastModified: new Date(),
            metadata: { title: Buffer.from('Q2 Report').toString('base64') },
          }),
        }),
      }),
    } as any,
    sessionMw: mockSession(),
  }));
  return app;
}

async function* emptyIterable() { /* empty */ }

function bearerHeader(): string {
  return `Bearer ${signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: SECRET })}`;
}

describe('GET /api/cloud/sas', () => {
  it('returns CloudWriteSasResponse for entitled container', async () => {
    const res = await request(makeApp({})).get('/api/cloud/sas').set('Authorization', bearerHeader());
    expect(res.status).toBe(200);
    expect(res.body.blob_endpoint).toBe(BLOB_ENDPOINT);
    expect(res.body.container).toBe(CONTAINER);
    expect(res.body.prefix).toBe(`${USER_ID}/`);
    expect(typeof res.body.sas_token).toBe('string');
    expect(res.body.sas_token).toMatch(/sr=d/);
    expect(res.body.sas_token).toMatch(/sdd=1/);
    expect(res.body.expires_at).toMatch(/T.*Z/);
  });

  it('403 when entitlement cloud not active', async () => {
    const app = makeApp({ listActive: vi.fn().mockResolvedValue([]) });
    const res = await request(app).get('/api/cloud/sas').set('Authorization', bearerHeader());
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/cloud|entitlement/i);
  });

  it('401 without bearer token', async () => {
    const res = await request(makeApp({})).get('/api/cloud/sas');
    expect(res.status).toBe(401);
  });

  it('500 when UDK fetch fails', async () => {
    const app = makeApp({ getUdk: vi.fn().mockRejectedValue(new Error('udk down')) });
    const res = await request(app).get('/api/cloud/sas').set('Authorization', bearerHeader());
    expect(res.status).toBe(500);
  });
});
```

Run: `pnpm --filter @lingxi/gateway test -- cloud`
Expected: module not found.

- [ ] **Step 2: Implement `/sas` (Task 4 only this endpoint; Task 5/6 add list+download in the same file)**

Create `apps/gateway/src/api/cloud.ts`:

```typescript
import { Router, type Router as RouterType, type Request, type Response, type RequestHandler } from 'express';
import { makeContainerTokenMiddleware } from '../auth/container-token.js';
import { buildDirectoryWriteSas } from '../lib/sas-builder.js';
import type { EntitlementsDao } from '../db/entitlements-dao.js';
import type { UserDelegationKeyCache } from '../lib/user-delegation-key-cache.js';
import type { CloudWriteSasResponse } from '@lingxi/shared';
import type { BlobServiceClient } from '@azure/storage-blob';

export interface CloudRouterConfig {
  accountName: string;
  container: string;
  blobEndpoint: string;
  writeSasTtlSeconds: number;
  readSasTtlSeconds: number;
}

export interface CloudRouterDeps {
  secret: string;
  config: CloudRouterConfig;
  entitlements: Pick<EntitlementsDao, 'listActive' | 'getTokenVersion'>;
  udkCache: Pick<UserDelegationKeyCache, 'get'>;
  blobServiceClient: Pick<BlobServiceClient, 'getContainerClient'>;
  sessionMw: RequestHandler;
}

const FEATURE = 'cloud';

export const buildCloudRouter = (deps: CloudRouterDeps): RouterType => {
  const router = Router();
  const containerAuth = makeContainerTokenMiddleware({
    secret: deps.secret,
    tokenVersionFetcher: (uid) => deps.entitlements.getTokenVersion(uid),
  });

  // Middleware that runs AFTER auth and checks the user has cloud entitlement.
  // Used by /sas (container path).
  const requireCloudForContainer = async (req: Request, res: Response, next: () => void) => {
    const userId = req.user_id!;
    try {
      const active = await deps.entitlements.listActive(userId);
      if (!active.includes(FEATURE)) {
        res.status(403).json({ error: 'cloud entitlement not active' });
        return;
      }
      next();
    } catch (err) {
      res.status(500).json({ error: 'internal', message: String(err) });
    }
  };

  router.get('/api/cloud/sas', containerAuth, requireCloudForContainer, async (req: Request, res: Response) => {
    const userId = req.user_id!;
    try {
      const udk = await deps.udkCache.get();
      const out = buildDirectoryWriteSas({
        account: deps.config.accountName,
        container: deps.config.container,
        userId,
        udk,
        ttlSeconds: deps.config.writeSasTtlSeconds,
      });
      const body: CloudWriteSasResponse = {
        blob_endpoint: deps.config.blobEndpoint,
        container: deps.config.container,
        prefix: out.prefix,
        sas_token: out.sasToken,
        expires_at: out.expiresAt.toISOString(),
      };
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: 'internal', message: String(err) });
    }
  });

  return router;
};
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @lingxi/gateway test -- cloud
pnpm --filter @lingxi/gateway test
pnpm --filter @lingxi/gateway run lint
git add apps/gateway/src/api/cloud.ts apps/gateway/test/api/cloud.test.ts
git commit -m "feat(gateway): /api/cloud/sas (container directory write SAS)"
```

Expected: 4 new tests pass; full suite 216+; lint clean.

---

## Task 5: `/api/cloud/list` route (extend cloud.ts)

**Files:**
- Modify: `apps/gateway/src/api/cloud.ts`
- Modify: `apps/gateway/test/api/cloud.test.ts`
- Modify: `packages/shared/src/contracts.ts` — add `CloudListResponse`, `CloudFileItem`, `CloudFolderItem`

`GET /api/cloud/list?prefix=...` — web 列云盘：
1. `requireSession` → 拿 user_id
2. entitlement 检查
3. 校验 `prefix` (用 `validateVirtualPath` 兼容；空 prefix 允许)
4. `containerClient.listBlobsByHierarchy('/', { prefix: '<user_id>/<prefix>' })`
5. 拆出 folders + files；每个 file 解 metadata base64 字段为 UTF-8
6. 返回 `CloudListResponse`

- [ ] **Step 1: 加 contracts**

In `packages/shared/src/contracts.ts`, append at end:

```typescript

/**
 * Cloud drive list response (P2 /api/cloud/list).
 * gateway 在此端点统一解码 metadata 的 base64 字段，前端不再解码。
 */
export interface CloudFileItem {
  virtual_path: string;       // relative to <user_id>/
  size: number;
  last_modified: string;      // ISO-8601
  content_type: string | null;
  metadata: {
    title: string;            // decoded UTF-8
    session_id: string | null;
    published_at: string | null;
    tool_version: string | null;
    description: string | null;
    tags: string[] | null;
  };
}

export interface CloudFolderItem {
  virtual_path: string;       // relative to <user_id>/, with trailing /
}

export interface CloudListResponse {
  folders: CloudFolderItem[];
  files: CloudFileItem[];
}
```

- [ ] **Step 2: 加 list 测试**

Append to `apps/gateway/test/api/cloud.test.ts` (inside the file, AFTER the existing `describe('GET /api/cloud/sas')` block):

```typescript

describe('GET /api/cloud/list', () => {
  // listBlobsByHierarchy mock helper — returns an async iterable
  function fakeListBlobs(items: Array<{ kind: 'prefix' | 'blob'; name: string; meta?: any; size?: number; contentType?: string }>) {
    return async function* () {
      for (const i of items) {
        if (i.kind === 'prefix') {
          yield { kind: 'prefix', name: i.name };
        } else {
          yield {
            kind: 'blob',
            name: i.name,
            properties: {
              contentLength: i.size ?? 0,
              lastModified: new Date('2026-06-02T10:00:00Z'),
              contentType: i.contentType ?? 'application/pdf',
            },
            metadata: i.meta ?? {},
          };
        }
      }
    };
  }

  function makeListApp(opts: { listFn?: any; listActive?: any; sessionUserId?: string }) {
    const userId = opts.sessionUserId ?? USER_ID;
    const app = express();
    app.use(express.json());
    app.use(buildCloudRouter({
      secret: SECRET,
      config: { accountName: ACCOUNT, container: CONTAINER, blobEndpoint: BLOB_ENDPOINT, writeSasTtlSeconds: 900, readSasTtlSeconds: 300 },
      entitlements: {
        listActive: opts.listActive ?? vi.fn().mockResolvedValue(['cloud']),
        getTokenVersion: vi.fn().mockResolvedValue(0),
      } as any,
      udkCache: { get: vi.fn() } as any,
      blobServiceClient: {
        getContainerClient: () => ({
          listBlobsByHierarchy: opts.listFn ?? (() => fakeListBlobs([])()),
          getBlobClient: () => ({ getProperties: vi.fn() }),
        }),
      } as any,
      sessionMw: ((req: any, _res: any, next: any) => { req.session = { user_id: userId }; next(); }) as any,
    }));
    return app;
  }

  it('returns folders and files at root for entitled user', async () => {
    const listFn = vi.fn(() => fakeListBlobs([
      { kind: 'prefix', name: `${USER_ID}/reports/` },
      { kind: 'blob', name: `${USER_ID}/q2.pdf`, size: 1024, contentType: 'application/pdf',
        meta: { title: Buffer.from('Q2 Sales').toString('base64'), session_id: 'main' } },
    ])());
    const app = makeListApp({ listFn });
    const res = await request(app).get('/api/cloud/list');
    expect(res.status).toBe(200);
    expect(res.body.folders).toEqual([{ virtual_path: 'reports/' }]);
    expect(res.body.files).toHaveLength(1);
    expect(res.body.files[0].virtual_path).toBe('q2.pdf');
    expect(res.body.files[0].size).toBe(1024);
    expect(res.body.files[0].metadata.title).toBe('Q2 Sales');
    expect(res.body.files[0].metadata.session_id).toBe('main');
  });

  it('respects prefix query parameter', async () => {
    const listFn = vi.fn(() => fakeListBlobs([
      { kind: 'blob', name: `${USER_ID}/reports/q1.pdf`, size: 200 },
    ])());
    const app = makeListApp({ listFn });
    const res = await request(app).get('/api/cloud/list?prefix=reports/');
    expect(res.status).toBe(200);
    expect(res.body.files[0].virtual_path).toBe('reports/q1.pdf');
    // verify the underlying call used the prefix
    expect(listFn.mock.calls[0][1].prefix).toBe(`${USER_ID}/reports/`);
  });

  it('rejects prefix with .. (path traversal)', async () => {
    const app = makeListApp({});
    const res = await request(app).get('/api/cloud/list?prefix=../other/');
    expect(res.status).toBe(400);
  });

  it('rejects prefix starting with / (absolute)', async () => {
    const app = makeListApp({});
    const res = await request(app).get('/api/cloud/list?prefix=/abs/');
    expect(res.status).toBe(400);
  });

  it('403 when cloud entitlement not active', async () => {
    const app = makeListApp({ listActive: vi.fn().mockResolvedValue([]) });
    const res = await request(app).get('/api/cloud/list');
    expect(res.status).toBe(403);
  });

  it('decodes Chinese title from metadata base64', async () => {
    const listFn = vi.fn(() => fakeListBlobs([
      { kind: 'blob', name: `${USER_ID}/销售.pdf`, size: 100,
        meta: { title: Buffer.from('销售报告').toString('base64'),
                description: Buffer.from('Q2 季度').toString('base64'),
                tags: Buffer.from('a,b,c').toString('base64') } },
    ])());
    const app = makeListApp({ listFn });
    const res = await request(app).get('/api/cloud/list');
    expect(res.body.files[0].metadata.title).toBe('销售报告');
    expect(res.body.files[0].metadata.description).toBe('Q2 季度');
    expect(res.body.files[0].metadata.tags).toEqual(['a', 'b', 'c']);
  });

  it('handles file without metadata (placeholder strings/null)', async () => {
    const listFn = vi.fn(() => fakeListBlobs([
      { kind: 'blob', name: `${USER_ID}/x.txt`, size: 0, meta: {} },
    ])());
    const app = makeListApp({ listFn });
    const res = await request(app).get('/api/cloud/list');
    expect(res.status).toBe(200);
    // missing title → use basename
    expect(res.body.files[0].metadata.title).toBe('x.txt');
    expect(res.body.files[0].metadata.session_id).toBeNull();
  });
});
```

Note: this assumes `validateVirtualPath` from `@lingxi/shared` accepts empty input as "root prefix"; if not, the route's path validation needs an inline branch for empty prefix → skip validation. The implementation below handles both.

- [ ] **Step 3: Implement `/list` in `cloud.ts`**

Edit `apps/gateway/src/api/cloud.ts` — add `validateVirtualPath` import and the new route. Add imports:

```typescript
import { validateVirtualPath } from '@lingxi/shared';
import type { CloudListResponse, CloudFileItem, CloudFolderItem } from '@lingxi/shared';
```

Append a new route handler INSIDE `buildCloudRouter`, after the `/sas` route:

```typescript
  router.get('/api/cloud/list', deps.sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;

    // entitlement check (web side)
    const active = await deps.entitlements.listActive(userId);
    if (!active.includes(FEATURE)) {
      res.status(403).json({ error: 'cloud entitlement not active' });
      return;
    }

    // prefix validation
    const prefixParam = (req.query['prefix'] as string) ?? '';
    if (prefixParam) {
      // Treat the prefix as a virtual-path-like input. validateVirtualPath rejects
      // trailing /, but a prefix legitimately ends with / — strip before validating,
      // then re-add.
      const trimmed = prefixParam.replace(/\/+$/, '');
      const v = validateVirtualPath(trimmed);
      if (!v.ok) {
        res.status(400).json({ error: `invalid prefix: ${v.error}` });
        return;
      }
    }
    // Normalize: ensure no leading /, ensure trailing / if non-empty
    let safePrefix = prefixParam;
    if (safePrefix && !safePrefix.endsWith('/')) safePrefix = safePrefix + '/';

    const fullPrefix = `${userId}/${safePrefix}`;
    const containerClient = deps.blobServiceClient.getContainerClient(deps.config.container);

    const folders: CloudFolderItem[] = [];
    const files: CloudFileItem[] = [];

    try {
      const iter = containerClient.listBlobsByHierarchy('/', { prefix: fullPrefix, includeMetadata: true } as any);
      for await (const item of iter) {
        if ((item as any).kind === 'prefix') {
          // a sub-"directory"
          const fullName = (item as any).name as string;          // e.g. '<userId>/reports/'
          const rel = fullName.slice(`${userId}/`.length);
          folders.push({ virtual_path: rel });
        } else {
          // a blob
          const blobName = (item as any).name as string;          // e.g. '<userId>/q2.pdf'
          const rel = blobName.slice(`${userId}/`.length);
          const props = (item as any).properties ?? {};
          const meta = (item as any).metadata ?? {};

          files.push({
            virtual_path: rel,
            size: props.contentLength ?? 0,
            last_modified: (props.lastModified instanceof Date ? props.lastModified : new Date(props.lastModified ?? Date.now())).toISOString(),
            content_type: props.contentType ?? null,
            metadata: decodeBlobMetadata(meta, rel),
          });
        }
      }
      const body: CloudListResponse = { folders, files };
      res.json(body);
    } catch (err) {
      res.status(502).json({ error: 'blob list failed', message: String(err) });
    }
  });
```

Add a helper function inside the same file (outside `buildCloudRouter`):

```typescript
function decodeB64Utf8(s: string | undefined): string | null {
  if (!s) return null;
  try { return Buffer.from(s, 'base64').toString('utf8'); }
  catch { return null; }
}

function decodeBlobMetadata(raw: Record<string, string>, fallbackBasename: string): CloudFileItem['metadata'] {
  return {
    title: decodeB64Utf8(raw['title']) ?? fallbackBasename.split('/').pop() ?? fallbackBasename,
    session_id: raw['session_id'] ?? null,
    published_at: raw['published_at'] ?? null,
    tool_version: raw['tool_version'] ?? null,
    description: decodeB64Utf8(raw['description']),
    tags: decodeB64Utf8(raw['tags'])?.split(',').map(s => s.trim()).filter(Boolean) ?? null,
  };
}
```

- [ ] **Step 4: Run + lint + commit**

```bash
pnpm --filter @lingxi/gateway test -- cloud
pnpm --filter @lingxi/gateway test
pnpm --filter @lingxi/gateway run lint
pnpm --filter @lingxi/shared run lint
git add apps/gateway/src/api/cloud.ts \
        apps/gateway/test/api/cloud.test.ts \
        packages/shared/src/contracts.ts
git commit -m "feat(gateway): /api/cloud/list (folders + files, decoded metadata)"
```

Expected: 7 new tests pass; full suite 223+; both lints clean.

---

## Task 6: `/api/cloud/download` route (extend cloud.ts)

**Files:**
- Modify: `apps/gateway/src/api/cloud.ts`
- Modify: `apps/gateway/test/api/cloud.test.ts`

`GET /api/cloud/download?path=...&dispose=inline|attachment` —
1. `requireSession` → user_id
2. entitlement check
3. 校验 `path` 用 `validateVirtualPath`
4. `getBlobClient(<user_id>/<path>).getProperties()` 验证存在 + 拿 metadata.title 用于文件名
5. 根据 `dispose` 决定 SAS 是否带 rscd:
   - `dispose='inline'`（默认）→ 不带 rscd
   - `dispose='attachment'` → 带 `rscd = buildContentDisposition('attachment', title)`
6. `buildReadBlobSas(...)` 签 SAS
7. 302 redirect 到 `${blob_endpoint}/${container}/${user_id}/${path}?${sas_token}`

- [ ] **Step 1: 加 download 测试**

Append to `apps/gateway/test/api/cloud.test.ts`:

```typescript

describe('GET /api/cloud/download', () => {
  function makeDownloadApp(opts: {
    pathExists?: boolean;
    blobTitle?: string;
    listActive?: any;
  }) {
    const app = express();
    app.use(express.json());
    app.use(buildCloudRouter({
      secret: SECRET,
      config: { accountName: ACCOUNT, container: CONTAINER, blobEndpoint: BLOB_ENDPOINT, writeSasTtlSeconds: 900, readSasTtlSeconds: 300 },
      entitlements: {
        listActive: opts.listActive ?? vi.fn().mockResolvedValue(['cloud']),
        getTokenVersion: vi.fn(),
      } as any,
      udkCache: { get: vi.fn().mockResolvedValue(fakeUdk()) } as any,
      blobServiceClient: {
        getContainerClient: () => ({
          listBlobsByHierarchy: () => (async function*() {})(),
          getBlobClient: () => ({
            getProperties: () => {
              if (opts.pathExists === false) {
                const err: any = new Error('not found');
                err.statusCode = 404;
                throw err;
              }
              return Promise.resolve({
                contentType: 'application/pdf',
                contentLength: 1024,
                lastModified: new Date(),
                metadata: { title: Buffer.from(opts.blobTitle ?? 'Report').toString('base64') },
              });
            },
          }),
        }),
      } as any,
      sessionMw: ((req: any, _res: any, next: any) => { req.session = { user_id: USER_ID }; next(); }) as any,
    }));
    return app;
  }

  it('302 redirects to blob URL with SAS (default inline)', async () => {
    const res = await request(makeDownloadApp({})).get('/api/cloud/download?path=reports/q2.pdf');
    expect(res.status).toBe(302);
    expect(res.headers['location']).toMatch(new RegExp(`^${BLOB_ENDPOINT}/${CONTAINER}/${USER_ID}/reports/q2.pdf\\?`));
    // default inline: SAS should NOT contain rscd
    expect(res.headers['location']).not.toMatch(/rscd=/);
  });

  it('attachment dispose adds rscd with ASCII filename', async () => {
    const res = await request(makeDownloadApp({ blobTitle: 'Report' }))
      .get('/api/cloud/download?path=reports/q2.pdf&dispose=attachment');
    expect(res.status).toBe(302);
    expect(res.headers['location']).toMatch(/rscd=/);
    expect(res.headers['location']).toMatch(/attachment/);
  });

  it('attachment with Chinese title encodes via RFC 5987 (filename*=UTF-8)', async () => {
    const res = await request(makeDownloadApp({ blobTitle: '销售报告.pdf' }))
      .get('/api/cloud/download?path=reports/q2.pdf&dispose=attachment');
    expect(res.status).toBe(302);
    const loc = res.headers['location'];
    // SDK will percent-encode the entire rscd value; check for the inner encoded form
    expect(decodeURIComponent(loc)).toMatch(/filename\*=UTF-8''/);
  });

  it('404 when blob does not exist', async () => {
    const res = await request(makeDownloadApp({ pathExists: false }))
      .get('/api/cloud/download?path=missing.pdf');
    expect(res.status).toBe(404);
  });

  it('400 on path with ..', async () => {
    const res = await request(makeDownloadApp({})).get('/api/cloud/download?path=../etc/passwd');
    expect(res.status).toBe(400);
  });

  it('400 on absolute path', async () => {
    const res = await request(makeDownloadApp({})).get('/api/cloud/download?path=/abs/path.pdf');
    expect(res.status).toBe(400);
  });

  it('400 when path query missing', async () => {
    const res = await request(makeDownloadApp({})).get('/api/cloud/download');
    expect(res.status).toBe(400);
  });

  it('403 when cloud entitlement not active', async () => {
    const app = makeDownloadApp({ listActive: vi.fn().mockResolvedValue([]) });
    const res = await request(app).get('/api/cloud/download?path=x.pdf');
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Implement `/download` in `cloud.ts`**

Add imports to `apps/gateway/src/api/cloud.ts`:

```typescript
import { buildReadBlobSas } from '../lib/sas-builder.js';
import { buildContentDisposition } from '../lib/content-disposition.js';
```

Append route handler inside `buildCloudRouter`, after `/list`:

```typescript
  router.get('/api/cloud/download', deps.sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;

    const active = await deps.entitlements.listActive(userId);
    if (!active.includes(FEATURE)) {
      res.status(403).json({ error: 'cloud entitlement not active' });
      return;
    }

    const pathParam = req.query['path'] as string | undefined;
    if (!pathParam) {
      res.status(400).json({ error: 'path query parameter required' });
      return;
    }

    const v = validateVirtualPath(pathParam);
    if (!v.ok) {
      res.status(400).json({ error: `invalid path: ${v.error}` });
      return;
    }

    const dispose = (req.query['dispose'] as string) === 'attachment' ? 'attachment' : 'inline';
    const fullPath = `${userId}/${pathParam}`;
    const containerClient = deps.blobServiceClient.getContainerClient(deps.config.container);
    const blobClient = containerClient.getBlobClient(fullPath);

    // HEAD: verify exists + get title for filename
    let props: { contentType?: string; metadata?: Record<string, string> };
    try {
      props = await blobClient.getProperties() as any;
    } catch (err: any) {
      if (err?.statusCode === 404 || /not found/i.test(String(err))) {
        res.status(404).json({ error: 'blob not found' });
        return;
      }
      res.status(502).json({ error: 'blob head failed', message: String(err) });
      return;
    }

    // Build SAS
    const udk = await deps.udkCache.get();
    let contentDisposition: string | undefined;
    if (dispose === 'attachment') {
      const title = decodeB64Utf8(props.metadata?.['title']) ?? pathParam.split('/').pop() ?? 'download';
      contentDisposition = buildContentDisposition('attachment', title);
    }

    const sas = buildReadBlobSas({
      account: deps.config.accountName,
      container: deps.config.container,
      blobName: fullPath,
      udk,
      ttlSeconds: deps.config.readSasTtlSeconds,
      contentDisposition,
    });

    const url = `${deps.config.blobEndpoint}/${deps.config.container}/${fullPath}?${sas.sasToken}`;
    res.redirect(302, url);
  });
```

- [ ] **Step 3: Run + lint + commit**

```bash
pnpm --filter @lingxi/gateway test -- cloud
pnpm --filter @lingxi/gateway test
pnpm --filter @lingxi/gateway run lint
git add apps/gateway/src/api/cloud.ts apps/gateway/test/api/cloud.test.ts
git commit -m "feat(gateway): /api/cloud/download with inline/attachment + RFC 5987 filename"
```

Expected: 8 new tests pass; full suite 231+; lint clean.

---

## Task 7: Wire to `index.ts` + 收尾

**Files:**
- Modify: `apps/gateway/src/index.ts`

把 cloud router 装到 gateway，注入 `blob-service-client` 工厂返回的 client + cache。

- [ ] **Step 1: 改 index.ts**

Add imports:

```typescript
import { buildCloudRouter } from './api/cloud.js';
import { getBlobServiceClient, getUserDelegationKeyCache } from './lib/blob-service-client.js';
```

Inside `if (sbResolved) { ... }` block, after the entitlements/me-entitlements/auth-refresh routes are mounted, add:

```typescript
    // P2: cloud data plane (SAS / list / download)
    // Only wire when cloud config is populated (otherwise local-dev without Azure creds would crash).
    if (config.cloud.storageAccount && config.cloud.blobEndpoint) {
      const blobServiceClient = getBlobServiceClient({
        accountName: config.cloud.storageAccount,
        blobEndpoint: config.cloud.blobEndpoint,
      });
      const udkCache = getUserDelegationKeyCache({
        accountName: config.cloud.storageAccount,
        blobEndpoint: config.cloud.blobEndpoint,
        udkLifetimeSeconds: config.cloud.udkLifetimeSeconds,
      });

      app.use(buildCloudRouter({
        secret: config.auth.gatewaySecret,
        config: {
          accountName: config.cloud.storageAccount,
          container: config.cloud.container,
          blobEndpoint: config.cloud.blobEndpoint,
          writeSasTtlSeconds: config.cloud.writeSasTtlSeconds,
          readSasTtlSeconds: config.cloud.readSasTtlSeconds,
        },
        entitlements: entitlementsDao,
        udkCache,
        blobServiceClient,
        sessionMw,
      }));
      console.log('[gateway] cloud routes mounted (account=' + config.cloud.storageAccount + ')');
    } else {
      console.log('[gateway] cloud routes skipped (AZURE_STORAGE_ACCOUNT not set)');
    }
```

- [ ] **Step 2: Lint + test + boot check**

```bash
pnpm --filter @lingxi/gateway run lint
pnpm --filter @lingxi/gateway test
cd /Users/yanjiayi/workspace/laifu && pnpm dev:gateway &
sleep 8
curl -s http://localhost:9000/healthz
PID=$(lsof -ti :9000); [ -n "$PID" ] && kill "$PID"
```

Expected: lint clean; tests 231+/231+ all green; `/healthz` returns `{"ok":true}` with `[gateway] cloud routes skipped...` in startup log (since `AZURE_STORAGE_ACCOUNT` isn't set in dev .env.local — that's expected behavior; cloud routes only available when Azure config provided).

- [ ] **Step 3: Commit**

```bash
git add apps/gateway/src/index.ts
git commit -m "feat(gateway): wire cloud router (SAS / list / download)"
```

- [ ] **Step 4: 全量验证**

```bash
SUPABASE_SERVICE_ROLE_KEY=$(grep ^SUPABASE_SERVICE_ROLE_KEY apps/gateway/.env.local | cut -d= -f2-) \
  pnpm test 2>&1 | tail -15
pnpm lint 2>&1 | tail -10
git log --oneline main..HEAD | head -10
```

Expected:
- gateway: 217+ passed, 14 skipped DAO; shared: 18+
- web: still 3 EventSource fails (preexisting, unrelated)
- lint: clean
- log shows the P2 commits at top

---

## 验收清单 (P2 整体)

- [ ] `blob-service-client` factory + 3 tests
- [ ] `content-disposition` lib + ~9 tests
- [ ] `buildReadBlobSas` extension + 5 tests
- [ ] `/api/cloud/sas` + 4 tests (entitled, 403 unentitled, 401 no token, 500 UDK fail)
- [ ] `/api/cloud/list` + 7 tests (root, with prefix, .. rejected, absolute rejected, 403, Chinese decode, missing metadata)
- [ ] `/api/cloud/download` + 8 tests (inline default, attachment ASCII, Chinese RFC 5987, 404, .., absolute, missing path, 403)
- [ ] `cloud.ts` total endpoint count = 3 routes mounted
- [ ] `CloudListResponse`/`CloudFileItem`/`CloudFolderItem` exported from `@lingxi/shared`
- [ ] `index.ts` mounts cloud router conditionally on AZURE_STORAGE_ACCOUNT
- [ ] All lints clean
- [ ] Full suite green (except preexisting EventSource fails)
- [ ] 7 commits on `feat/cloud-drive`

---

## 风险与未决项

| 项 | 风险 | 缓解 |
|---|---|---|
| `getProperties()` for missing blob — error shape | Azure SDK throws differently across versions: some throw `RestError` with `statusCode`, others throw `Error` with message containing "BlobNotFound" | Try catch on both `err.statusCode === 404` and `/not found/i` test. If integration fails, narrow further. |
| `listBlobsByHierarchy` iteration shape (`item.kind`, item.name, item.properties) | SDK 12.x stable but param name nuances | Cast to `any` in TypeScript; tests use the documented shape. Real Azure smoke-test in Task 12 (verify-cloud-sas.ts) doesn't cover list — separate post-merge smoke needed. |
| BlobServiceClient with DefaultAzureCredential locally | Local dev without az login → credential chain fails at request time, not at construction time | Conditional mount in index.ts so dev without Azure creds doesn't crash gateway startup |
| Empty `prefix` validation | `validateVirtualPath('')` returns ok=false (path is empty), but for /list root prefix it's legitimate | Implementation skips validation when prefix is empty string |
| `decodeBlobMetadata` field `title` fallback | If blob was published without title metadata, we use basename — could be ugly | Acceptable; P3 cloud-publish sets title server-side from CLI args |
| SDK `contentDisposition` → `rscd` query param mapping | Confirmed in SDK v12.20+; the `rscd` is percent-encoded by SDK during stringify | Tests decode `location` header to assert inner form |

### Open Questions

- For /list, do we need pagination? P2 returns everything matching prefix; if a user has 10k+ files, response is large. **Defer** — add pagination in P6 when Files App polish lands.
- For /download, should we issue a one-time token instead of a 5-min SAS? **No** — SAS is fine; one-time tokens add stateful complexity.
- Should /list cache the response (Cache-Control header)? **No for MVP** — entitlement state can change mid-session; freshness matters.

---

## 相关文档

- 设计 spec：`docs/superpowers/specs/2026-06-01-cloud-drive-design.md`
- P0 plan：`docs/superpowers/plans/2026-06-01-cloud-drive-p0.md`
- P1 plan：`docs/superpowers/plans/2026-06-02-cloud-drive-p1.md`
