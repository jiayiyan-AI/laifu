# Cloud Drive — P0 基建准备 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地云盘 MVP 的基础设施和共享构件 —— HNS-enabled Azure storage、`packages/shared` 的 virtual-path 校验 / 云盘 contracts、gateway 的 user-delegation-key 缓存和 directory-scoped SAS builder —— 让 P1 / P2 能在牢固地基上动工。

**Architecture:** 控制平面 / 数据平面分离。P0 只搭"签发"侧的最小骨架：gateway 能用 User Delegation Key 签出限定到 `<user_id>/` 子树的 directory SAS（`sr=d` + `sdd=1`），并通过真 Azure 验收：跨前缀的 PUT 会被服务端 403。

**Tech Stack:**
- Node.js 24 / TypeScript / Express / vitest (gateway 已有)
- `@azure/storage-blob` (新增依赖) / `@azure/identity` (已有)
- pnpm workspace (`@lingxi/shared`、`@lingxi/gateway`)
- Azure Storage Account (HNS / ADLS Gen2)

**Out of scope for P0:**
- entitlement 表 / `/api/cloud/*` 路由 / 容器侧 publish CLI（P1+ 范围）
- gateway 业务路由的接入 —— P0 只交付库 + 验收脚本
- Web UI / Files App（P5+）

**Spec reference:** `docs/superpowers/specs/2026-06-01-cloud-drive-design.md` 第十段表格 P0 行；第三段（命名约定）；第五段（SAS 签发逻辑）；第十一段（Azurite directory SAS 风险）

---

## File Structure (P0 范围)

```
新增:
  infra/azure/cloud-storage.md                                   操作 runbook，列 az CLI 命令
  packages/shared/vitest.config.ts                               packages/shared 测试入口
  packages/shared/src/lib/virtual-path.ts                        路径校验
  packages/shared/test/virtual-path.test.ts                      路径校验测试
  apps/gateway/src/lib/user-delegation-key-cache.ts              UDK 缓存（6h 重用）
  apps/gateway/test/lib/user-delegation-key-cache.test.ts        缓存单测
  apps/gateway/src/lib/sas-builder.ts                            directory-scoped SAS 签发
  apps/gateway/test/lib/sas-builder.test.ts                      SAS 结构验证
  scripts/verify-cloud-sas.ts                                    手动验收脚本（真 Azure）

修改:
  apps/gateway/package.json                                       + @azure/storage-blob
  apps/gateway/src/config.ts                                      + cloud / gateway secret 配置
  packages/shared/package.json                                    + vitest 依赖 + test 脚本
  packages/shared/src/index.ts                                    + export lib
  packages/shared/src/contracts.ts                                + 云盘 types
```

每个 src 文件单一职责：

| 文件 | 职责 |
|---|---|
| `virtual-path.ts` | 纯函数 `validateVirtualPath`，校验路径合法性，给 gateway 和 web 共享 |
| `user-delegation-key-cache.ts` | 缓存 Azure UDK（7d 有效，6h 刷新窗口），避免每次签 SAS 都打 Azure |
| `sas-builder.ts` | 把 UDK + (user_id, permissions, ttl) 组装成限定到 `<user_id>/` 的 directory SAS token |
| `verify-cloud-sas.ts` | 端到端验收：连真 Azure 签 SAS → 跨前缀 PUT 应 403、同前缀 PUT 应 201 |

---

## Task 0: 起步检查

**Files:** 无

- [ ] **Step 1: 确认当前分支和工作树干净**

Run: `git status && git branch --show-current`
Expected:
```
On branch feat/cloud-drive
nothing to commit, working tree clean
```

如果不在 `feat/cloud-drive` 分支，先 `git checkout feat/cloud-drive`。

- [ ] **Step 2: 确认 spec 文件存在**

Run: `ls -la docs/superpowers/specs/2026-06-01-cloud-drive-design.md`
Expected: 文件存在，约 1190+ 行。

---

## Task 1: Azure 基建 runbook（写文档，不立即执行）

**Files:**
- Create: `infra/azure/cloud-storage.md`

P0 实施者拿到这个 runbook 后会自己跑 az CLI 创建资源。文档是交付物，因为 spec 风险段标记了"P0 开始前在 Azurite 跑 directory SAS 实测"——本地能跑就用 Azurite，跑不通才上真 Azure dev account。

- [ ] **Step 1: 创建 infra 目录**

Run: `mkdir -p infra/azure`
Expected: 目录创建（已存在不报错）。

- [ ] **Step 2: 写 runbook**

Create `infra/azure/cloud-storage.md`:

````markdown
# Cloud Drive — Storage Setup Runbook

P0 基建：创建 HNS-enabled storage account + container `laifu-cloud`，给 gateway 用的身份赋
"Storage Blob Data Owner" 角色（签 User Delegation Key 必需）。

## 1. 变量

```bash
export AZ_RG=lingxi-rg                 # 已有 resource group
export AZ_LOC=eastasia                 # 同 ACA 所在 region
export STORAGE_ACCOUNT=laifudev        # prod 用 laifuprod；dev 用 laifudev
export CONTAINER=laifu-cloud
```

## 2. 创建 HNS-enabled storage account

```bash
az storage account create \
  --name "$STORAGE_ACCOUNT" \
  --resource-group "$AZ_RG" \
  --location "$AZ_LOC" \
  --sku Standard_LRS \
  --kind StorageV2 \
  --hierarchical-namespace true \
  --enable-hierarchical-namespace true \
  --min-tls-version TLS1_2 \
  --allow-blob-public-access false
```

**关键参数**：`--hierarchical-namespace true` 启用 ADLS Gen2，这是 directory-scoped
SAS (`sr=d` + `sdd`) 的前提。若用扁平 Blob storage，签出的 SAS 会退化成 container
SAS，racwl 权限会覆盖整个 container —— 多租户隔离失效。

## 3. 创建 container

```bash
az storage container create \
  --name "$CONTAINER" \
  --account-name "$STORAGE_ACCOUNT" \
  --auth-mode login
```

## 4. 给 gateway 的身份赋角色

User Delegation Key 必须由有 "Storage Blob Data Owner"（或 Data Contributor）
角色的身份签发。开发期可以用当前 az 登录的用户：

```bash
SUBSCRIPTION_ID=$(az account show --query id -o tsv)
USER_OBJECT_ID=$(az ad signed-in-user show --query id -o tsv)

az role assignment create \
  --assignee-object-id "$USER_OBJECT_ID" \
  --assignee-principal-type User \
  --role "Storage Blob Data Owner" \
  --scope "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$AZ_RG/providers/Microsoft.Storage/storageAccounts/$STORAGE_ACCOUNT"
```

生产环境用 ACA 容器的 Managed Identity / Service Principal，参数换成
`--assignee-object-id <MI 的 principal id> --assignee-principal-type ServicePrincipal`。

## 5. 记录到 .env.local

```
AZURE_STORAGE_ACCOUNT=laifudev
AZURE_STORAGE_CONTAINER=laifu-cloud
AZURE_STORAGE_BLOB_ENDPOINT=https://laifudev.blob.core.windows.net
```

## 6. Azurite (本地开发) 兼容性

Azurite 对 HNS / directory-scoped SAS 的支持历史上不完整。本地开发推荐：
- 单元测试：用 mock UDK，断言 SAS 字符串结构（无需真 storage）
- 集成测试：先尝试 Azurite，跑不通则用真 Azure dev account（`laifudev`）
- P0 验收脚本（`scripts/verify-cloud-sas.ts`）必须用真 Azure 跑，确认跨前缀 PUT 真被拒

跑 Azurite：
```bash
docker run -p 10000:10000 mcr.microsoft.com/azure-storage/azurite \
  azurite-blob --blobHost 0.0.0.0 --enableHierarchicalNamespace true
```
（`--enableHierarchicalNamespace` 是较新版才有的 flag，未必所有版本都生效）

## 7. 删除（实验完清理）

```bash
az storage account delete --name "$STORAGE_ACCOUNT" --resource-group "$AZ_RG" --yes
```
````

- [ ] **Step 3: Commit**

```bash
git add infra/azure/cloud-storage.md
git commit -m "docs(cloud-drive): P0 Azure storage setup runbook"
```

---

## Task 2: 装 `@azure/storage-blob` 依赖

**Files:**
- Modify: `apps/gateway/package.json`

- [ ] **Step 1: 安装依赖**

Run: `pnpm --filter @lingxi/gateway add @azure/storage-blob@^12.20.0`
Expected: 装好，`pnpm-lock.yaml` 更新。

- [ ] **Step 2: 验证版本和导出**

Run: `pnpm --filter @lingxi/gateway exec node -e "const m = require('@azure/storage-blob'); console.log(Object.keys(m).filter(k => k.includes('SAS') || k.includes('UserDelegation')).join('\n'))"`
Expected stdout 包含：
```
generateBlobSASQueryParameters
BlobSASPermissions
BlobSASSignatureValues
UserDelegationKeyCredential
SASProtocol
```

（如果输出里看不到 `BlobSASSignatureValues`，说明版本不对，回退安装并升级到 12.20+）

- [ ] **Step 3: Commit**

```bash
git add apps/gateway/package.json pnpm-lock.yaml
git commit -m "feat(gateway): add @azure/storage-blob for cloud SAS signing"
```

---

## Task 3: 扩展 gateway config 加云盘 / token 相关字段

**Files:**
- Modify: `apps/gateway/src/config.ts`

引入 `cloud` 配置组和 `gatewaySecret`。validateConfig 在 azure mode 下要求 storage container 名 + endpoint，但 gatewaySecret 在 dev 模式也必须有（即使用默认值不安全也要给个值，不然 JWT 签不出来）。

- [ ] **Step 1: 修改 config.ts**

Edit `apps/gateway/src/config.ts` — 在 `azure` 配置组**之后**追加 `cloud` 组，并在 `session` 同级加 `gatewaySecret`：

在文件中 `export const config = {` 内部的 `azure: { ... },` 这一组之后、闭合 `};` 之前，插入：

```typescript
  // 容器到 gateway 的 JWT 签发密钥；P1 启用后 user_entitlements / refresh-token 都用它。
  // dev 默认是占位值；生产必须显式设。
  gatewaySecret: process.env['GATEWAY_SECRET'] ?? 'dev-only-gateway-secret',

  cloud: {
    storageAccount: process.env['AZURE_STORAGE_ACCOUNT'] ?? '',
    container: process.env['AZURE_STORAGE_CONTAINER'] ?? 'laifu-cloud',
    blobEndpoint:
      process.env['AZURE_STORAGE_BLOB_ENDPOINT'] ??
      (process.env['AZURE_STORAGE_ACCOUNT']
        ? `https://${process.env['AZURE_STORAGE_ACCOUNT']}.blob.core.windows.net`
        : ''),
    // User Delegation Key 自身的 TTL（Azure 上限 7d）；缓存使用方在剩余 < 1h 时刷新。
    udkLifetimeSeconds: parseInt(process.env['AZURE_STORAGE_UDK_LIFETIME_SECONDS'] ?? `${7 * 24 * 3600}`, 10),
    // 写 SAS TTL（每个容器拿一次 SAS 用多久）
    writeSasTtlSeconds: parseInt(process.env['AZURE_STORAGE_WRITE_SAS_TTL_SECONDS'] ?? '900', 10),     // 15min
    // 读 SAS TTL（每次 download 签一个）
    readSasTtlSeconds:  parseInt(process.env['AZURE_STORAGE_READ_SAS_TTL_SECONDS']  ?? '300', 10),     // 5min
  },
```

在文件底部 `validateConfig` 函数体内、`if (config.provisioner === 'azure') {` 块的末尾（最后一行 `}` 之前），追加：

```typescript
    required('AZURE_STORAGE_ACCOUNT');         // cloud drive 也用这个 storage account
    // 不强制要求 GATEWAY_SECRET 在 dev 里改，但提示
```

并且在 `validateConfig` 函数的 `if (config.provisioner === 'azure') {` 块**之外**（即对所有 provisioner 都校验），追加：

```typescript
  if (config.gatewaySecret === 'dev-only-gateway-secret') {
    console.warn('[config] GATEWAY_SECRET is the dev default — set a real one for prod');
  }
```

- [ ] **Step 2: TypeScript 校验通过**

Run: `pnpm --filter @lingxi/gateway run lint`
Expected: 无错误（`tsc --noEmit` 通过）。

- [ ] **Step 3: 现有测试不挂**

Run: `pnpm --filter @lingxi/gateway test`
Expected: 全绿（应只有 healthz / thread-stream 几个测试，全 PASS）。

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/src/config.ts
git commit -m "feat(gateway): add cloud + gatewaySecret config"
```

---

## Task 4: `packages/shared` 加 vitest + 测试入口

**Files:**
- Modify: `packages/shared/package.json`
- Create: `packages/shared/vitest.config.ts`

- [ ] **Step 1: 加 vitest 依赖到 shared**

Run: `pnpm --filter @lingxi/shared add -D vitest@^1.4.0`
Expected: 装好。

- [ ] **Step 2: 加 test 脚本**

Edit `packages/shared/package.json`，把 `scripts` 部分改成：

```json
  "scripts": {
    "build": "tsc",
    "lint": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
```

- [ ] **Step 3: 创建 vitest 配置**

Create `packages/shared/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: 创建 test 目录占位**

Run: `mkdir -p packages/shared/test`
Expected: 目录创建。

- [ ] **Step 5: 验证 vitest 至少能跑（空 suite 不报错）**

Run: `pnpm --filter @lingxi/shared test`
Expected: vitest 报"No test files found"或类似（不算 fail，是正常退出）。如果 vitest 真报 fail，可以先暂时加一个 dummy test 验证再删 —— 但通常 vitest 1.4 空 suite 是 exit 0。

- [ ] **Step 6: Commit**

```bash
git add packages/shared/package.json packages/shared/vitest.config.ts pnpm-lock.yaml
git commit -m "chore(shared): set up vitest for packages/shared"
```

---

## Task 5: `validateVirtualPath` —— 写失败测试

**Files:**
- Create: `packages/shared/test/virtual-path.test.ts`

按 spec §三的校验规则：
- 不允许 `..`、绝对路径开头 `/`、空段
- 单段长度 ≤ 200，总长 ≤ 1024
- 字符集 UTF-8；除 `/` 外不允许 `\` `\0` 等控制字符
- 大小写敏感

- [ ] **Step 1: 写测试文件**

Create `packages/shared/test/virtual-path.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { validateVirtualPath } from '../src/lib/virtual-path.js';

describe('validateVirtualPath', () => {
  describe('合法路径', () => {
    it('单层文件名', () => {
      expect(validateVirtualPath('report.pdf')).toEqual({ ok: true });
    });

    it('多层嵌套', () => {
      expect(validateVirtualPath('reports/2026-06/sales.pdf')).toEqual({ ok: true });
    });

    it('UTF-8 中文文件名', () => {
      expect(validateVirtualPath('reports/销售/季度报告.pdf')).toEqual({ ok: true });
    });

    it('数字 + 短划线 + 下划线 + 点', () => {
      expect(validateVirtualPath('logs/2026-06-01_run.log.gz')).toEqual({ ok: true });
    });
  });

  describe('非法路径', () => {
    it('空字符串', () => {
      const r = validateVirtualPath('');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/empty/i);
    });

    it('绝对路径（以 / 开头）', () => {
      const r = validateVirtualPath('/reports/x.pdf');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/absolute|leading slash/i);
    });

    it('包含 .. 段', () => {
      const r = validateVirtualPath('reports/../etc/passwd');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/\.\.|parent/i);
    });

    it('单独 .. 段', () => {
      const r = validateVirtualPath('..');
      expect(r.ok).toBe(false);
    });

    it('. 段（当前目录指代）也禁', () => {
      const r = validateVirtualPath('./report.pdf');
      expect(r.ok).toBe(false);
    });

    it('空段（连续 //）', () => {
      const r = validateVirtualPath('reports//x.pdf');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/empty segment/i);
    });

    it('末尾 /', () => {
      const r = validateVirtualPath('reports/');
      expect(r.ok).toBe(false);
    });

    it('反斜杠', () => {
      const r = validateVirtualPath('reports\\x.pdf');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/backslash|invalid char/i);
    });

    it('NUL 字符', () => {
      const r = validateVirtualPath('reports/x\x00.pdf');
      expect(r.ok).toBe(false);
    });

    it('其他控制字符（换行）', () => {
      const r = validateVirtualPath('reports/x\n.pdf');
      expect(r.ok).toBe(false);
    });

    it('单段超长（>200）', () => {
      const longSeg = 'a'.repeat(201);
      const r = validateVirtualPath(`reports/${longSeg}.pdf`);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/segment.*long|too long/i);
    });

    it('总长超长（>1024）', () => {
      // 多个 200 长度的合法段叠起来
      const seg = 'a'.repeat(200);
      const path = Array(6).fill(seg).join('/'); // 6 * 200 + 5 separators = 1205
      const r = validateVirtualPath(path);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/total length|too long/i);
    });
  });
});
```

- [ ] **Step 2: 跑测试，确认全 fail（因为实现还不存在）**

Run: `pnpm --filter @lingxi/shared test`
Expected: 报错说 `Cannot find module '../src/lib/virtual-path.js'` 或类似 ENOENT。这是正常的，下一步实现。

---

## Task 6: `validateVirtualPath` —— 实现

**Files:**
- Create: `packages/shared/src/lib/virtual-path.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: 创建 lib 目录**

Run: `mkdir -p packages/shared/src/lib`
Expected: 目录创建。

- [ ] **Step 2: 实现 validateVirtualPath**

Create `packages/shared/src/lib/virtual-path.ts`:

```typescript
export type ValidationResult = { ok: true } | { ok: false; error: string };

const MAX_SEGMENT_LEN = 200;
const MAX_TOTAL_LEN = 1024;

// 控制字符（U+0000 到 U+001F 和 U+007F）+ 反斜杠
const CONTROL_OR_BACKSLASH = /[\x00-\x1f\x7f\\]/;

/**
 * 校验 agent 提供的虚拟路径是否合法。
 *
 * 规则（与 spec §三 一致）：
 * - 非空，不以 '/' 开头，不以 '/' 结尾
 * - 用 '/' 分段后：每段非空、不为 '.' 或 '..'、长度 ≤ 200
 * - 总长度 ≤ 1024
 * - 不含反斜杠或控制字符（除 '/' 分隔符外）
 *
 * 注意：大小写敏感由调用方负责（Blob 自身大小写敏感）。
 * 不规范化路径（不 collapse `//`、不解析 `.`）—— 任何形态偏差直接拒。
 */
export function validateVirtualPath(path: string): ValidationResult {
  if (path.length === 0) return { ok: false, error: 'path is empty' };
  if (path.length > MAX_TOTAL_LEN) {
    return { ok: false, error: `path total length ${path.length} exceeds max ${MAX_TOTAL_LEN}` };
  }
  if (path.startsWith('/')) return { ok: false, error: 'path is absolute (leading slash)' };
  if (path.endsWith('/')) return { ok: false, error: 'path has trailing slash' };
  if (CONTROL_OR_BACKSLASH.test(path)) {
    return { ok: false, error: 'path contains backslash or control character' };
  }

  const segments = path.split('/');
  for (const seg of segments) {
    if (seg.length === 0) {
      return { ok: false, error: 'path has empty segment (consecutive /)' };
    }
    if (seg === '.' || seg === '..') {
      return { ok: false, error: `path contains parent/current segment "${seg}"` };
    }
    if (seg.length > MAX_SEGMENT_LEN) {
      return { ok: false, error: `segment too long (${seg.length} > ${MAX_SEGMENT_LEN})` };
    }
  }

  return { ok: true };
}
```

- [ ] **Step 3: 从 packages/shared 的入口导出**

Edit `packages/shared/src/index.ts`，在文件末尾追加：

```typescript
export * from './lib/virtual-path.js';
```

- [ ] **Step 4: 跑测试，确认全 pass**

Run: `pnpm --filter @lingxi/shared test`
Expected: 所有 17 个用例 PASS。

- [ ] **Step 5: TypeScript build 校验**

Run: `pnpm --filter @lingxi/shared run lint`
Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/lib/virtual-path.ts \
        packages/shared/src/index.ts \
        packages/shared/test/virtual-path.test.ts
git commit -m "feat(shared): validateVirtualPath for cloud drive path safety"
```

---

## Task 7: `contracts.ts` 扩展云盘 types

**Files:**
- Modify: `packages/shared/src/contracts.ts`

P0 只加"显然以后会用、现在 sas-builder 也用得到"的 types。其他（CloudListResponse、Entitlements 等）留到 P1 再加。

- [ ] **Step 1: 在 contracts.ts 文件末尾追加云盘 types**

Edit `packages/shared/src/contracts.ts`，**在文件末尾追加**（不要打乱现有内容顺序）：

```typescript

// === Cloud Drive 契约 (P0 起步，P1/P2 继续扩展) ===

/**
 * Container（hermes 容器内）拿到的写 SAS 配置。
 * P1 `/api/cloud/sas` 端点返回此 shape。
 *
 * `sas_token` 已经是 directory-scoped (sr=d, sdd=1)，授权范围严格限制在
 * `<container>/<prefix>` 子树。客户端拼 URL 时用：
 *   `${blob_endpoint}/${container}/${prefix}<virtual_path>?${sas_token}`
 */
export interface CloudWriteSasResponse {
  blob_endpoint: string;      // e.g. "https://laifudev.blob.core.windows.net"
  container: string;          // "laifu-cloud"
  prefix: string;             // "<user_id>/", 含尾 /
  sas_token: string;          // 不含前导 '?' 的 query 字符串
  expires_at: string;         // ISO-8601
}

/**
 * Cloud drive 操作允许的权限集合（spec §五）。
 * write SAS 通常给 racwl，read SAS 通常只给 r。
 */
export type CloudSasPermission = 'r' | 'a' | 'c' | 'w' | 'l' | 'd';
```

- [ ] **Step 2: TypeScript 校验**

Run: `pnpm --filter @lingxi/shared run lint`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/contracts.ts
git commit -m "feat(shared): cloud drive SAS contract types"
```

---

## Task 8: `UserDelegationKeyCache` —— 写失败测试

**Files:**
- Create: `apps/gateway/test/lib/user-delegation-key-cache.test.ts`

策略：mock Azure SDK 的"拿 UDK"方法，注入一个返回固定 `UserDelegationKey` 的 stub。验证缓存窗口、首次/复用/刷新分支。

`UserDelegationKey` 是 Azure SDK 导出的 interface，字段包括 `signedObjectId`、`signedTenantId`、`signedStartsOn`、`signedExpiresOn`、`signedService`、`signedVersion`、`value`。我们做测试只需要 `signedExpiresOn` 反映过期时间。

- [ ] **Step 1: 创建 test 目录**

Run: `mkdir -p apps/gateway/test/lib`
Expected: 已存在（thread-stream.test.ts 已经在），不报错。

- [ ] **Step 2: 写测试文件**

Create `apps/gateway/test/lib/user-delegation-key-cache.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import type { UserDelegationKey } from '@azure/storage-blob';
import { UserDelegationKeyCache } from '../../src/lib/user-delegation-key-cache.js';

function fakeKey(expiresInSeconds: number): UserDelegationKey {
  const now = new Date();
  const expires = new Date(now.getTime() + expiresInSeconds * 1000);
  return {
    signedObjectId: 'fake-oid',
    signedTenantId: 'fake-tid',
    signedStartsOn: now.toISOString(),
    signedExpiresOn: expires.toISOString(),
    signedService: 'b',
    signedVersion: '2020-02-10',
    value: 'fake-udk-value',
  };
}

describe('UserDelegationKeyCache', () => {
  it('首次 get 调用 fetcher 并返回 key', async () => {
    const fetcher = vi.fn().mockResolvedValue(fakeKey(7 * 24 * 3600));
    const cache = new UserDelegationKeyCache({ fetcher, refreshWithinSeconds: 3600 });

    const key = await cache.get();
    expect(key.value).toBe('fake-udk-value');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('缓存有效期内复用，不再调 fetcher', async () => {
    const fetcher = vi.fn().mockResolvedValue(fakeKey(7 * 24 * 3600));
    const cache = new UserDelegationKeyCache({ fetcher, refreshWithinSeconds: 3600 });

    await cache.get();
    await cache.get();
    await cache.get();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('当 cached key 距过期 < refreshWithinSeconds 时刷新', async () => {
    // 第一次返回一个"剩余 30 分钟"的 key，第二次返回 7 天新的
    const firstKey = fakeKey(30 * 60);                 // 30min remaining
    const secondKey = fakeKey(7 * 24 * 3600);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(firstKey)
      .mockResolvedValueOnce(secondKey);

    const cache = new UserDelegationKeyCache({ fetcher, refreshWithinSeconds: 3600 }); // 1h window
    const k1 = await cache.get();
    expect(k1.signedExpiresOn).toBe(firstKey.signedExpiresOn);

    const k2 = await cache.get();
    // 30min < 1h 触发刷新，应拿到 second key
    expect(k2.signedExpiresOn).toBe(secondKey.signedExpiresOn);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('fetcher 抛错时 get 抛同样错，不污染缓存', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(fakeKey(7 * 24 * 3600));
    const cache = new UserDelegationKeyCache({ fetcher, refreshWithinSeconds: 3600 });

    await expect(cache.get()).rejects.toThrow('boom');
    // 再叫一次，应该重试 fetcher（缓存没污染）
    const k = await cache.get();
    expect(k.value).toBe('fake-udk-value');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('forceRefresh() 跳过缓存直接刷新', async () => {
    const k1 = fakeKey(7 * 24 * 3600);
    const k2 = fakeKey(7 * 24 * 3600);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(k1)
      .mockResolvedValueOnce(k2);

    const cache = new UserDelegationKeyCache({ fetcher, refreshWithinSeconds: 3600 });
    await cache.get();
    await cache.forceRefresh();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 3: 跑测试，确认全 fail**

Run: `pnpm --filter @lingxi/gateway test -- user-delegation-key-cache`
Expected: 报错 `Cannot find module '../../src/lib/user-delegation-key-cache.js'`。下一步实现。

---

## Task 9: `UserDelegationKeyCache` —— 实现

**Files:**
- Create: `apps/gateway/src/lib/user-delegation-key-cache.ts`

- [ ] **Step 1: 实现 UserDelegationKeyCache**

Create `apps/gateway/src/lib/user-delegation-key-cache.ts`:

```typescript
import type { UserDelegationKey } from '@azure/storage-blob';

export interface UserDelegationKeyCacheOptions {
  /**
   * 拉取新 UDK 的函数。生产里用 BlobServiceClient.getUserDelegationKey(start, expiry)。
   * 测试里传 stub。
   */
  fetcher: () => Promise<UserDelegationKey>;

  /**
   * 当 cached key 距 signedExpiresOn < 此秒数时，下次 get() 会触发刷新。
   * spec 推荐 3600s（提前 1 小时刷新，UDK 自身 7d TTL）。
   */
  refreshWithinSeconds: number;
}

/**
 * 缓存 Azure User Delegation Key，避免每次签 SAS 都打 Azure。
 *
 * UDK 自身有 TTL（上限 7 天），cache 里只存最近一次拉到的 key，
 * 在剩余时间窗内复用，临近过期时透明刷新。
 *
 * 不持久化 —— gateway 重启后会重新拉。
 *
 * 单实例非线程安全（Node.js 是 single-threaded，无所谓）。但并发请求
 * 都会触发刷新时，多个 fetcher 调用会被并发发起 —— 接受这点，
 * Azure 服务端拿同样 UDK 不算重复。如果将来要避免，加 Promise dedupe。
 */
export class UserDelegationKeyCache {
  private cached: UserDelegationKey | null = null;
  private readonly fetcher: () => Promise<UserDelegationKey>;
  private readonly refreshWithinMs: number;

  constructor(opts: UserDelegationKeyCacheOptions) {
    this.fetcher = opts.fetcher;
    this.refreshWithinMs = opts.refreshWithinSeconds * 1000;
  }

  async get(): Promise<UserDelegationKey> {
    if (this.cached && !this.isExpiringSoon(this.cached)) {
      return this.cached;
    }
    return this.refresh();
  }

  async forceRefresh(): Promise<UserDelegationKey> {
    return this.refresh();
  }

  private async refresh(): Promise<UserDelegationKey> {
    // 不预先清空 cached：若 fetcher 抛错，下次 get 还可以触发重试，但不污染之前的 cache。
    // 这里特意把"赋值"放在 await 之后，确保抛错时 cached 不被覆盖。
    const fresh = await this.fetcher();
    this.cached = fresh;
    return fresh;
  }

  private isExpiringSoon(key: UserDelegationKey): boolean {
    const expiresAt = new Date(key.signedExpiresOn).getTime();
    return expiresAt - Date.now() < this.refreshWithinMs;
  }
}
```

- [ ] **Step 2: 跑测试，确认全 pass**

Run: `pnpm --filter @lingxi/gateway test -- user-delegation-key-cache`
Expected: 5 个用例全 PASS。

- [ ] **Step 3: TypeScript 校验**

Run: `pnpm --filter @lingxi/gateway run lint`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/src/lib/user-delegation-key-cache.ts \
        apps/gateway/test/lib/user-delegation-key-cache.test.ts
git commit -m "feat(gateway): UserDelegationKeyCache for SAS signing"
```

---

## Task 10: `sas-builder` —— 写失败测试

**Files:**
- Create: `apps/gateway/test/lib/sas-builder.test.ts`

测试不真打 Azure，而是断言生成的 SAS query string 满足以下结构（spec §五）：
- `sr=d`（directory scope）
- `sdd=1`（user_id 占 1 层）
- `sv=2020-02-10` 或更高
- `sp=racwl` 或其子集
- `spr=https`
- `se=` 到期时间
- `sig=` HMAC 签名

`@azure/storage-blob` 的 `generateBlobSASQueryParameters(values, userDelegationKey, accountName)` 会返回一个 `SASQueryParameters` 对象，调 `.toString()` 拿到 query string。

- [ ] **Step 1: 写测试文件**

Create `apps/gateway/test/lib/sas-builder.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { UserDelegationKey } from '@azure/storage-blob';
import { buildDirectoryWriteSas } from '../../src/lib/sas-builder.js';

const ACCOUNT = 'laifudev';
const CONTAINER = 'laifu-cloud';
const USER_ID = '6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f';

function fakeUdk(): UserDelegationKey {
  const now = new Date();
  const expires = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
  return {
    signedObjectId: '00000000-0000-0000-0000-000000000001',
    signedTenantId: '00000000-0000-0000-0000-000000000002',
    signedStartsOn: now.toISOString(),
    signedExpiresOn: expires.toISOString(),
    signedService: 'b',
    signedVersion: '2020-02-10',
    // 32 字节 base64 UDK 值；签名时只需是 valid base64 即可，内容随便
    value: Buffer.from('a'.repeat(32)).toString('base64'),
  };
}

function parseSas(token: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of token.split('&')) {
    const [k, v] = part.split('=', 2);
    if (k) out[k] = decodeURIComponent(v ?? '');
  }
  return out;
}

describe('buildDirectoryWriteSas', () => {
  it('生成的 SAS 是 directory-scoped (sr=d, sdd=1)', () => {
    const { sasToken } = buildDirectoryWriteSas({
      account: ACCOUNT,
      container: CONTAINER,
      userId: USER_ID,
      udk: fakeUdk(),
      ttlSeconds: 900,
    });

    const params = parseSas(sasToken);
    expect(params['sr']).toBe('d');
    expect(params['sdd']).toBe('1');
  });

  it('signedVersion >= 2020-02-10', () => {
    const { sasToken } = buildDirectoryWriteSas({
      account: ACCOUNT,
      container: CONTAINER,
      userId: USER_ID,
      udk: fakeUdk(),
      ttlSeconds: 900,
    });

    const params = parseSas(sasToken);
    expect(params['sv']).toBeDefined();
    expect(params['sv']! >= '2020-02-10').toBe(true);
  });

  it('权限 racwl 全集', () => {
    const { sasToken } = buildDirectoryWriteSas({
      account: ACCOUNT,
      container: CONTAINER,
      userId: USER_ID,
      udk: fakeUdk(),
      ttlSeconds: 900,
    });

    const params = parseSas(sasToken);
    // sp 字段顺序由 SDK 决定，按字符集合比较
    const perms = new Set(params['sp']!.split(''));
    expect(perms.has('r')).toBe(true);
    expect(perms.has('a')).toBe(true);
    expect(perms.has('c')).toBe(true);
    expect(perms.has('w')).toBe(true);
    expect(perms.has('l')).toBe(true);
  });

  it('强制 HTTPS only (spr=https)', () => {
    const { sasToken } = buildDirectoryWriteSas({
      account: ACCOUNT,
      container: CONTAINER,
      userId: USER_ID,
      udk: fakeUdk(),
      ttlSeconds: 900,
    });

    const params = parseSas(sasToken);
    expect(params['spr']).toBe('https');
  });

  it('expiresAt 大致是 now + ttlSeconds', () => {
    const before = Date.now();
    const { expiresAt } = buildDirectoryWriteSas({
      account: ACCOUNT,
      container: CONTAINER,
      userId: USER_ID,
      udk: fakeUdk(),
      ttlSeconds: 900,
    });
    const after = Date.now();
    const expiresMs = expiresAt.getTime();
    // 允许 ±5s 误差
    expect(expiresMs).toBeGreaterThanOrEqual(before + 900_000 - 5000);
    expect(expiresMs).toBeLessThanOrEqual(after + 900_000 + 5000);
  });

  it('返回 prefix 以 user_id/ 结尾', () => {
    const { prefix } = buildDirectoryWriteSas({
      account: ACCOUNT,
      container: CONTAINER,
      userId: USER_ID,
      udk: fakeUdk(),
      ttlSeconds: 900,
    });
    expect(prefix).toBe(`${USER_ID}/`);
  });

  it('sas token 含 sig', () => {
    const { sasToken } = buildDirectoryWriteSas({
      account: ACCOUNT,
      container: CONTAINER,
      userId: USER_ID,
      udk: fakeUdk(),
      ttlSeconds: 900,
    });
    const params = parseSas(sasToken);
    expect(params['sig']).toBeDefined();
    expect(params['sig']!.length).toBeGreaterThan(20);
  });
});
```

- [ ] **Step 2: 跑测试，确认全 fail**

Run: `pnpm --filter @lingxi/gateway test -- sas-builder`
Expected: `Cannot find module '../../src/lib/sas-builder.js'`。

---

## Task 11: `sas-builder` —— 实现

**Files:**
- Create: `apps/gateway/src/lib/sas-builder.ts`

实现思路：用 `@azure/storage-blob` 的 `generateBlobSASQueryParameters(values, udk, accountName)`。`BlobSASSignatureValues` 设：
- `containerName`：`laifu-cloud`
- `blobName`：`<user_id>`（**不含尾 /**，SDK 会自动当成目录处理）
- `permissions`：`BlobSASPermissions.from({ read, add, create, write, list })`
- `expiresOn`、`startsOn`
- `protocol`：`SASProtocol.Https`
- `version`：`'2020-02-10'`（最早支持 `sdd` 的版本）

SDK 在 v12.20+ 对 directory SAS 的处理：当 storage account 启用 HNS 且传 `blobName` + 不传 `versionId`，签出来的 SAS 会自动带 `sr=d`，并根据 `blobName` 的 `/` 数量推断 `sdd`。
**如果实际签出来不是 `sr=d` / 没 `sdd`**（SDK 版本或 storage account 非 HNS），实现需要手动追加这些参数 —— 测试会发现问题，按下面的 fallback 处理。

- [ ] **Step 1: 实现 sas-builder.ts**

Create `apps/gateway/src/lib/sas-builder.ts`:

```typescript
import {
  generateBlobSASQueryParameters,
  BlobSASPermissions,
  SASProtocol,
  UserDelegationKeyCredential,
  type UserDelegationKey,
  type BlobSASSignatureValues,
} from '@azure/storage-blob';

export interface DirectoryWriteSasInput {
  account: string;       // storage account name, e.g. "laifudev"
  container: string;     // "laifu-cloud"
  userId: string;        // UUID, 作为一级目录
  udk: UserDelegationKey;
  ttlSeconds: number;    // SAS TTL, 推荐 900 (15min)
}

export interface DirectoryWriteSasOutput {
  sasToken: string;            // query string, 不含前导 '?'
  expiresAt: Date;
  prefix: string;              // "<userId>/"
}

const SAS_VERSION = '2020-02-10'; // 最早支持 sdd 的 service version

/**
 * 签发一个 directory-scoped User Delegation SAS，授权 racwl 限定到
 * `<container>/<userId>/` 子树。
 *
 * 客户端拼 URL 时形如：
 *   `${blob_endpoint}/${container}/${userId}/<virtual_path>?${sasToken}`
 *
 * directory SAS 要求 storage account 启用 Hierarchical Namespace
 * （ADLS Gen2）。非 HNS 账号签出来的会退化成 container SAS，不安全 —
 * 测试 + 验收脚本会发现这种偏差。
 */
export function buildDirectoryWriteSas(input: DirectoryWriteSasInput): DirectoryWriteSasOutput {
  const startsOn = new Date(Date.now() - 60 * 1000);        // 留 1 分钟时钟漂移
  const expiresOn = new Date(Date.now() + input.ttlSeconds * 1000);

  // BlobSASPermissions 没有 'a' 字段名，要用 .add；这里用 from 配 list 字段
  // (BlobSASPermissions.from 接受字段为 read/add/create/write/list/delete/...)。
  const permissions = BlobSASPermissions.from({
    read: true,
    add: true,
    create: true,
    write: true,
    list: true,
  });

  const sasValues: BlobSASSignatureValues = {
    containerName: input.container,
    // 关键：blobName 设为 userId（一级目录），SDK 在 HNS 模式下会签成 sr=d sdd=1
    blobName: input.userId,
    permissions,
    protocol: SASProtocol.Https,
    startsOn,
    expiresOn,
    version: SAS_VERSION,
  };

  const credential = new UserDelegationKeyCredential(input.account, input.udk);
  const sasQueryParams = generateBlobSASQueryParameters(sasValues, credential);

  let sasToken = sasQueryParams.toString();

  // 防御：SDK 在某些版本/路径下不会自动加 sr=d / sdd，手动确保。
  // 若已存在，不重复加；不存在，按 spec §五 补上。
  const tokenParams = new URLSearchParams(sasToken);
  if (!tokenParams.has('sr') || tokenParams.get('sr') !== 'd') {
    tokenParams.set('sr', 'd');
  }
  if (!tokenParams.has('sdd')) {
    tokenParams.set('sdd', '1');
  }
  sasToken = tokenParams.toString();

  return {
    sasToken,
    expiresAt: expiresOn,
    prefix: `${input.userId}/`,
  };
}
```

⚠️ **关于手动补 sr=d/sdd 的注意点**：
- 如果 SDK 已经签成了 directory SAS（sr=d sdd=1），上面的 `set` 是 noop，签名 sig 仍然 valid（参数集没变）。
- 如果 SDK 签成了 container SAS（sr=c），手动改 sr=d **不重签 sig**，会让 SAS 整体 invalid（服务端验签失败）。
- 实际跑 SDK 应该走对路径；上面的"防御"是 belt-and-suspenders。在 Task 12 验收脚本里会暴露：如果防御真的改写了 sr 字段，sig 会失效 → 跨前缀拒不掉 → 验收失败 → 实施者必须改成手动签算法（refer Microsoft Learn: https://learn.microsoft.com/en-us/rest/api/storageservices/create-user-delegation-sas）。

- [ ] **Step 2: 跑测试，确认全 pass**

Run: `pnpm --filter @lingxi/gateway test -- sas-builder`
Expected: 7 个用例全 PASS。

如果某个用例 fail（例如 `sr` 不是 `'d'`）—— 说明 SDK 没自动签成 directory SAS。这种情况下实施者必须改实现为"手动算 sig + 拼 SAS string"，不能只用 SDK + 改字符串。具体步骤：
1. 引入 `crypto`，按 Microsoft Learn 的 [User Delegation SAS string-to-sign 算法](https://learn.microsoft.com/en-us/rest/api/storageservices/create-user-delegation-sas) 拼 stringToSign
2. 用 `udk.value`（base64-decode）作为 HMAC-SHA256 密钥签 stringToSign
3. 把 sig 和其他参数拼成 query string

实施时若走到这一步，把这个变更也写进 commit message。

- [ ] **Step 3: 现有所有测试不挂**

Run: `pnpm --filter @lingxi/gateway test`
Expected: 全绿（healthz + thread-stream + udk cache + sas builder）。

- [ ] **Step 4: TypeScript 校验**

Run: `pnpm --filter @lingxi/gateway run lint`
Expected: 无错误。

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/lib/sas-builder.ts \
        apps/gateway/test/lib/sas-builder.test.ts
git commit -m "feat(gateway): directory-scoped User Delegation SAS builder"
```

---

## Task 12: 手动验收脚本 — 端到端真 Azure 验证

**Files:**
- Create: `scripts/verify-cloud-sas.ts`

P0 的最终验收标准（spec §十表格）：用骨架签一个 SAS → 验证跨前缀的 PUT 被 Azure **真的** 403。

这一步**必须**用真 Azure dev account 跑（Azurite 对 directory SAS 支持不全 —— 见 spec §十一）。实施者跑通后才能 P0 结题。

- [ ] **Step 1: 创建 scripts 目录验证**

Run: `ls scripts/`
Expected: 目录已存在（有 `dev-hermes.sh` 等）。

- [ ] **Step 2: 写验收脚本**

Create `scripts/verify-cloud-sas.ts`:

```typescript
/**
 * P0 验收脚本 —— 真 Azure 验证 directory SAS 限定到 prefix 是否生效。
 *
 * 流程：
 *   1. 用 DefaultAzureCredential 连 Azure（要求 az login 完成 + 当前账号有
 *      "Storage Blob Data Owner" 角色 in laifu-cloud container）
 *   2. 拿 User Delegation Key (7d)
 *   3. 用 sas-builder 给一个 fake user_id = "user-a" 签 SAS
 *   4. PUT 文件到 user-a/test.txt → 应 201
 *   5. PUT 文件到 user-b/test.txt → 应 403 (跨前缀)
 *   6. 再签一个 user-b 的 SAS
 *   7. 用 user-b 的 SAS PUT 到 user-a/test.txt → 应 403
 *
 * 跑法:
 *   az login
 *   export AZURE_STORAGE_ACCOUNT=laifudev
 *   export AZURE_STORAGE_CONTAINER=laifu-cloud
 *   pnpm --filter @lingxi/gateway exec tsx ../../scripts/verify-cloud-sas.ts
 */

import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { buildDirectoryWriteSas } from '../apps/gateway/src/lib/sas-builder.js';
import { UserDelegationKeyCache } from '../apps/gateway/src/lib/user-delegation-key-cache.js';

const account = process.env['AZURE_STORAGE_ACCOUNT'];
const container = process.env['AZURE_STORAGE_CONTAINER'] ?? 'laifu-cloud';
if (!account) {
  console.error('Missing AZURE_STORAGE_ACCOUNT env. See infra/azure/cloud-storage.md.');
  process.exit(1);
}
const endpoint = `https://${account}.blob.core.windows.net`;

const credential = new DefaultAzureCredential();
const serviceClient = new BlobServiceClient(endpoint, credential);

const udkCache = new UserDelegationKeyCache({
  fetcher: async () => {
    const now = new Date(Date.now() - 60_000);
    const expiry = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    return serviceClient.getUserDelegationKey(now, expiry);
  },
  refreshWithinSeconds: 3600,
});

const USER_A = 'user-a-' + Date.now();
const USER_B = 'user-b-' + Date.now();

async function tryPut(sasUrl: string, body: string): Promise<{ ok: boolean; status: number; }> {
  const resp = await fetch(sasUrl, {
    method: 'PUT',
    headers: {
      'x-ms-blob-type': 'BlockBlob',
      'Content-Length': String(Buffer.byteLength(body)),
    },
    body,
  });
  return { ok: resp.ok, status: resp.status };
}

async function main() {
  console.log(`[verify] storage account: ${account}`);
  console.log(`[verify] container:       ${container}`);

  const udk = await udkCache.get();
  console.log(`[verify] got UDK, expires: ${udk.signedExpiresOn}`);

  // === user-A SAS ===
  const sasA = buildDirectoryWriteSas({
    account: account!,
    container,
    userId: USER_A,
    udk,
    ttlSeconds: 900,
  });
  console.log(`[verify] SAS for ${USER_A}: ${sasA.sasToken.slice(0, 80)}...`);

  // === Case 1: PUT 到自己 prefix → 应 201 ===
  const urlA_own = `${endpoint}/${container}/${USER_A}/hello.txt?${sasA.sasToken}`;
  const r1 = await tryPut(urlA_own, 'hello from user A');
  console.log(`[case 1] PUT ${USER_A}/hello.txt -> ${r1.status} (expected 201)`);
  if (r1.status !== 201) {
    console.error('  ❌ FAIL: 同前缀 PUT 应 201');
    process.exit(2);
  }

  // === Case 2: 用 user-A 的 SAS PUT 到 user-B → 应 403 ===
  const urlA_cross = `${endpoint}/${container}/${USER_B}/x.txt?${sasA.sasToken}`;
  const r2 = await tryPut(urlA_cross, 'malicious cross-write');
  console.log(`[case 2] PUT ${USER_B}/x.txt with USER_A SAS -> ${r2.status} (expected 403)`);
  if (r2.status !== 403) {
    console.error('  ❌ FAIL: 跨前缀 PUT 必须 403');
    console.error('  原因可能: SAS 实际是 container-scope (sr=c), 不是 directory-scope。');
    console.error('  检查: storage account 是否启用 HNS / SDK 版本是否支持 directory SAS。');
    process.exit(3);
  }

  // === Case 3: user-B 的 SAS 拿来跨前缀也要 403 ===
  const sasB = buildDirectoryWriteSas({
    account: account!,
    container,
    userId: USER_B,
    udk,
    ttlSeconds: 900,
  });
  const urlB_cross = `${endpoint}/${container}/${USER_A}/y.txt?${sasB.sasToken}`;
  const r3 = await tryPut(urlB_cross, 'B trying to write to A');
  console.log(`[case 3] PUT ${USER_A}/y.txt with USER_B SAS -> ${r3.status} (expected 403)`);
  if (r3.status !== 403) {
    console.error('  ❌ FAIL: 反向跨前缀 PUT 必须 403');
    process.exit(4);
  }

  console.log('\n✅ P0 acceptance PASS — directory SAS 限定 prefix 真生效');
}

main().catch((err) => {
  console.error('[verify] fatal:', err);
  process.exit(1);
});
```

- [ ] **Step 3: 跑脚本验收（需要 Azure 已按 Task 1 runbook 准备好）**

Run:
```bash
az login   # 如果还没登
export AZURE_STORAGE_ACCOUNT=laifudev
export AZURE_STORAGE_CONTAINER=laifu-cloud
pnpm --filter @lingxi/gateway exec tsx ../../scripts/verify-cloud-sas.ts
```

Expected stdout:
```
[verify] storage account: laifudev
[verify] container:       laifu-cloud
[verify] got UDK, expires: 2026-06-08T...Z
[verify] SAS for user-a-...: ...
[case 1] PUT user-a-.../hello.txt -> 201 (expected 201)
[case 2] PUT user-b-.../x.txt with USER_A SAS -> 403 (expected 403)
[case 3] PUT user-a-.../y.txt with USER_B SAS -> 403 (expected 403)

✅ P0 acceptance PASS — directory SAS 限定 prefix 真生效
```

如果 case 2 / 3 不是 403：
- 检查 storage account 是否真启用了 HNS：
  `az storage account show -n $AZURE_STORAGE_ACCOUNT --query "isHnsEnabled"` 应返回 `true`
- 检查 SDK 实际签出来的 sr/sdd：在脚本里加 `console.log('sas:', sasA.sasToken)` 检查
- 如果 SDK 版本太旧（< 12.20）或不支持 HNS directory SAS，按 Task 11 Step 2 的 fallback 改成手动签

- [ ] **Step 4: 验收成功后清理测试 blob**

```bash
az storage blob delete-batch \
  --account-name "$AZURE_STORAGE_ACCOUNT" \
  --source "$AZURE_STORAGE_CONTAINER" \
  --pattern "user-a-*/**" --auth-mode login

az storage blob delete-batch \
  --account-name "$AZURE_STORAGE_ACCOUNT" \
  --source "$AZURE_STORAGE_CONTAINER" \
  --pattern "user-b-*/**" --auth-mode login
```

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-cloud-sas.ts
git commit -m "feat(scripts): P0 acceptance — verify directory SAS prefix isolation"
```

---

## Task 13: 收尾 — 全量测试 + 推 PR

**Files:** 无新增

- [ ] **Step 1: 全量测试**

Run: `pnpm test`
Expected: 所有 workspace 的测试全 PASS。

- [ ] **Step 2: 全量 lint**

Run: `pnpm lint`
Expected: 无错误。

- [ ] **Step 3: 检查 commit 历史**

Run: `git log --oneline main..HEAD`
Expected: 看到 P0 的若干提交（约 10 个），都遵循 conventional commits 风格，跟 P0 spec 段落对应。

- [ ] **Step 4: 推到远端**

Run: `git push -u origin feat/cloud-drive`
Expected: 远端建好分支。

- [ ] **Step 5: 开 PR（人工确认是否在此时推）**

通过 `gh pr create` 或网页开 PR，target main。PR 描述指向：
- spec：`docs/superpowers/specs/2026-06-01-cloud-drive-design.md`
- 本 plan：`docs/superpowers/plans/2026-06-01-cloud-drive-p0.md`
- 验收：附 `verify-cloud-sas.ts` 的真 Azure 跑通截图 / 日志

---

## 验收清单（P0 整体）

- [ ] HNS-enabled storage account + `laifu-cloud` container 创建成功
- [ ] gateway 装好 `@azure/storage-blob`
- [ ] `config.cloud` 字段齐全，`validateConfig()` 在 azure mode 下要求 storage 配置
- [ ] `packages/shared/src/lib/virtual-path.ts` 17 个测试全绿
- [ ] `packages/shared/src/contracts.ts` 多出 `CloudWriteSasResponse` + `CloudSasPermission`
- [ ] `UserDelegationKeyCache` 5 个测试全绿，覆盖：首次拿、缓存复用、临近过期刷新、fetcher 错误恢复、forceRefresh
- [ ] `buildDirectoryWriteSas` 7 个测试全绿，覆盖：sr=d、sdd=1、sv ≥ 2020-02-10、racwl 权限、HTTPS only、exp 计算、prefix 形式、sig 存在
- [ ] `scripts/verify-cloud-sas.ts` 在真 Azure 跑通：同前缀 PUT 201，跨前缀 PUT 403（两个方向都验）
- [ ] 全量 `pnpm test` 绿色；`pnpm lint` 无错
- [ ] 13 个 commit 干净，分支推到远端
