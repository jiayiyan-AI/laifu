# Hermes 邮件能力 B3:能力接入 + handle 自动分配 + 防漂移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让"邮件"作为一条能力卡出现在 web 市场、可装备/退订;装备时网关自动给该用户分配一个 email handle(localpart `u-<8hex>`,改名后置 v2);把 catalog ↔ 网关白名单的同步收敛到 `@lingxi/shared` 单一来源 + 一个防漂移测试;补齐 bicep 的 email env(env 三处守则第三处)。

**Architecture:** `@lingxi/shared` 导出 `MANAGEABLE_FEATURES`(`['cloud','email']`)作唯一来源,网关 `ALLOWED_FEATURES` 由它派生,web catalog 用一个单测断言"所有 removable 能力 id 集合 === MANAGEABLE_FEATURES",漂移即测试红。handle 分配走一个**通用** `onEnable(userId, feature)` 钩子挂在 entitlements 路由上(不在通用 handler 里 special-case),index.ts 把它接到"feature==='email' 时 ensureEmailAddress"。装备流程对前端完全不变(沿用通用 CapabilityEquip)。

**Tech Stack:** TypeScript ESM(import 带 `.js`)、Express、vitest + supertest、React、Bicep。

---

## 背景与决策(实现者必读)

- **handle 分配决策(用户已拍板)**:装备邮件能力时**自动分配** localpart = `u-<userId 去横线前 8 hex>`(与 NFS 子目录 / `purchase.ts` shortHash 同源、全局唯一性靠 `email_addresses.localpart` PK 兜底),零 UI。客户自选/改名留到后续迭代。display_name 本期传 null(发信 From 名回落到 config `EMAIL_FROM_DEFAULT_NAME`),"按业务名"留待后续。
- **现状**:
  - `apps/gateway/src/api/entitlements.ts` 的 `ALLOWED_FEATURES = new Set(['cloud'])`,且有注释"子项 B 会追加 'email'"。
  - `apps/gateway/test/api/entitlements.test.ts` **有一条** `email is NOT yet allowed in sub-project A → 404` 的测试 —— **B3 会翻转它**(email 变成允许)。
  - `apps/web/src/lib/capabilities.tsx` 的 `CAPABILITIES` 目前只有 web/file/wechat(基线,不可移除)+ cloud(可移除、进市场、有 desktopApp)。ManageApp/Desktop/Dock 全 catalog 驱动,加一条目即生效,**无需改组件**。
  - `apps/gateway/src/config.ts` + `apps/gateway/.env.example` 的 email env 已在 B1 落好;**只差 `infra/bicep/main.bicep`**。
  - email 路由在 `index.ts` 的 `{}` 块里、`buildEntitlementsRouter(...)` **之后**构造 `emailDao`。B3 要把 `emailDao` 构造**上移**到 entitlements 路由之前,以便把 `ensureEmailAddress` 接进 `onEnable`。
- **参照测试风格**:`apps/gateway/test/db/email-dao.test.ts`(链式 mock sb)、`apps/gateway/test/api/entitlements.test.ts`(supertest + vi.fn 依赖)。
- 改 `@lingxi/shared` 后必须 `pnpm --filter @lingxi/shared build`,否则 gateway/web 引用的是旧 dist。

## 文件结构

```
packages/shared/src/contracts.ts          # + MANAGEABLE_FEATURES 常量 + ManageableFeature 类型
apps/gateway/src/api/entitlements.ts       # ALLOWED_FEATURES 派生自 shared; + onEnable 钩子
apps/gateway/src/db/email-dao.ts           # + insertAddress
apps/gateway/src/api/email-provision.ts    # 新建: defaultLocalpart + ensureEmailAddress
apps/gateway/src/index.ts                  # emailDao 上移; 接 onEnable
apps/web/src/lib/icons.tsx                 # + IconMail
apps/web/src/lib/capabilities.tsx          # + email 能力卡
apps/web/src/lib/capabilities.test.ts      # 新建: 防漂移测试
infra/bicep/main.bicep                     # + email appSettings
infra/README.md                            # + 两个 postmark KV secret 占位说明
```

---

### Task 1: `@lingxi/shared` 导出 `MANAGEABLE_FEATURES`(单一来源)

**Files:**
- Modify: `packages/shared/src/contracts.ts`(文件末尾追加)

- [ ] **Step 1: 在 `packages/shared/src/contracts.ts` 末尾追加常量 + 类型**

```typescript
/**
 * 可经 /api/entitlements/:feature/(enable|disable) 管理的能力 id —— 单一来源。
 * 网关 ALLOWED_FEATURES 由此派生; web catalog 的 removable 能力 id 必须与此集合一致
 * (apps/web/src/lib/capabilities.test.ts 有防漂移断言)。
 * 新增可装备能力时只改这里 + web catalog。
 */
export const MANAGEABLE_FEATURES = ['cloud', 'email'] as const;
export type ManageableFeature = (typeof MANAGEABLE_FEATURES)[number];
```

- [ ] **Step 2: build shared,确认导出可用**

Run: `pnpm --filter @lingxi/shared build`
Expected: 成功,无类型错误。

- [ ] **Step 3: 验证 barrel 导出**

Run: `node -e "import('@lingxi/shared').then(m => console.log(m.MANAGEABLE_FEATURES))"` (在仓库根)
Expected: 打印 `[ 'cloud', 'email' ]`。
(若该方式因 ESM/路径解析不便,改为 `grep -q MANAGEABLE_FEATURES packages/shared/dist/contracts.js` 确认已编译进 dist。)

- [ ] **Step 4: 提交**

```bash
git add packages/shared/src/contracts.ts
git commit -m "feat(shared): MANAGEABLE_FEATURES 单一来源 (cloud+email)"
```

---

### Task 2: 网关 `ALLOWED_FEATURES` 派生自 shared(放开 email)

**Files:**
- Modify: `apps/gateway/src/api/entitlements.ts:6`
- Test: `apps/gateway/test/api/entitlements.test.ts:120-131`(翻转既有用例)

- [ ] **Step 1: 改既有测试 —— email 从"404 不允许"翻转为"允许"**

打开 `apps/gateway/test/api/entitlements.test.ts`,把 `feature allowlist` describe 里那条:

```typescript
  it('email is NOT yet allowed in sub-project A → 404', async () => {
    const enable = vi.fn();
    const app = makeApp({
      enable, disable: vi.fn(), listActive: vi.fn(),
      bumpTokenVersion: vi.fn(), restartContainer: vi.fn(),
      signTokenAndInject: vi.fn(),
    });
    const res = await request(app).post('/api/entitlements/email/enable');
    expect(res.status).toBe(404);
    expect(enable).not.toHaveBeenCalled();
  });
```

整体替换为:

```typescript
  it('email is now allowed (sub-project B) → enable proceeds', async () => {
    const enable = vi.fn().mockResolvedValue({ changed: true });
    const app = makeApp({
      enable, disable: vi.fn(), listActive: vi.fn().mockResolvedValue(['email']),
      bumpTokenVersion: vi.fn().mockResolvedValue(1), restartContainer: vi.fn().mockResolvedValue(undefined),
      signTokenAndInject: vi.fn().mockResolvedValue(undefined),
    });
    const res = await request(app).post('/api/entitlements/email/enable');
    expect(res.status).toBe(200);
    expect(enable).toHaveBeenCalledWith(USER_ID, 'email');
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @lingxi/gateway exec vitest run test/api/entitlements.test.ts`
Expected: 新用例 FAIL —— 当前 `ALLOWED_FEATURES` 没有 email,返回 404。

- [ ] **Step 3: 改 `entitlements.ts` 让白名单派生自 shared**

`apps/gateway/src/api/entitlements.ts` 顶部 import 加入 `MANAGEABLE_FEATURES`:

```typescript
import type { EntitlementChangeResponse } from '@lingxi/shared';
import { MANAGEABLE_FEATURES } from '@lingxi/shared';
```

把第 6 行:

```typescript
const ALLOWED_FEATURES = new Set<string>(['cloud']);   // 子项 B 会追加 'email'
```

替换为:

```typescript
// 白名单派生自 @lingxi/shared 单一来源, 避免与前端 catalog 漂移 (见 capabilities.test.ts)。
const ALLOWED_FEATURES = new Set<string>(MANAGEABLE_FEATURES);
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @lingxi/gateway exec vitest run test/api/entitlements.test.ts`
Expected: 全 PASS(含翻转后的 email 用例、unknown→404 用例)。

- [ ] **Step 5: 提交**

```bash
git add apps/gateway/src/api/entitlements.ts apps/gateway/test/api/entitlements.test.ts
git commit -m "feat(entitlements): ALLOWED_FEATURES 派生自 shared, 放开 email"
```

---

### Task 3: `emailDao.insertAddress`(为 handle 分配铺路)

**Files:**
- Modify: `apps/gateway/src/db/email-dao.ts`(interface + impl)
- Test: `apps/gateway/test/db/email-dao.test.ts`(追加)

- [ ] **Step 1: 在 `email-dao.test.ts` 追加 insertAddress 测试**

在文件末尾追加:

```typescript
describe('emailDao.insertAddress', () => {
  it('插入 localpart 行 (小写化 localpart)', async () => {
    const { chain, calls } = mockSb({ data: null, error: null });
    const dao = makeEmailDao(chain as any);
    await dao.insertAddress('u1', 'U-AbC123', '顺成贸易');
    expect(calls.inserted.localpart).toBe('u-abc123');
    expect(calls.inserted.user_id).toBe('u1');
    expect(calls.inserted.display_name).toBe('顺成贸易');
  });

  it('error → 抛出', async () => {
    const { chain } = mockSb({ data: null, error: { message: 'duplicate key', code: '23505' } });
    const dao = makeEmailDao(chain as any);
    await expect(dao.insertAddress('u1', 'taken', null)).rejects.toThrow(/insertAddress/);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @lingxi/gateway exec vitest run test/db/email-dao.test.ts`
Expected: FAIL —— `insertAddress` 不存在。

- [ ] **Step 3: 实现 insertAddress**

`apps/gateway/src/db/email-dao.ts` 的 `EmailDao` interface 追加(放在 `getAddress` 之后):

```typescript
  insertAddress(userId: string, localpart: string, displayName: string | null): Promise<void>;
```

`makeEmailDao` 实现里追加(放在 `getAddress` 实现之后):

```typescript
  async insertAddress(userId, localpart, displayName) {
    const { error } = await sb.from('email_addresses').insert({
      localpart: localpart.toLowerCase(),
      user_id: userId,
      display_name: displayName,
    });
    if (error) throw new Error(`insertAddress: ${error.message}`);
  },
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @lingxi/gateway exec vitest run test/db/email-dao.test.ts`
Expected: 全 PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/gateway/src/db/email-dao.ts apps/gateway/test/db/email-dao.test.ts
git commit -m "feat(email-dao): insertAddress (localpart 小写化)"
```

---

### Task 4: `email-provision.ts` —— defaultLocalpart + ensureEmailAddress

**Files:**
- Create: `apps/gateway/src/api/email-provision.ts`
- Test: `apps/gateway/test/api/email-provision.test.ts`

- [ ] **Step 1: 写失败测试 `test/api/email-provision.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { defaultLocalpart, ensureEmailAddress } from '../../src/api/email-provision.js';

const UID = '6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f';

describe('defaultLocalpart', () => {
  it('= u- + 去横线前 8 hex', () => {
    expect(defaultLocalpart(UID)).toBe('u-6e8b21f0');
  });
});

describe('ensureEmailAddress', () => {
  it('已有地址 → 直接返回, 不 insert', async () => {
    const dao = {
      getAddress: vi.fn().mockResolvedValue({ localpart: 'sunco', display_name: null }),
      insertAddress: vi.fn(),
    };
    const lp = await ensureEmailAddress(dao as any, UID);
    expect(lp).toBe('sunco');
    expect(dao.insertAddress).not.toHaveBeenCalled();
  });

  it('无地址 → 插入默认 localpart 并返回', async () => {
    const dao = {
      getAddress: vi.fn().mockResolvedValue(null),
      insertAddress: vi.fn().mockResolvedValue(undefined),
    };
    const lp = await ensureEmailAddress(dao as any, UID);
    expect(lp).toBe('u-6e8b21f0');
    expect(dao.insertAddress).toHaveBeenCalledWith(UID, 'u-6e8b21f0', null);
  });

  it('插入冲突但 re-query 已存在(并发)→ 返回已存在的', async () => {
    const dao = {
      getAddress: vi.fn()
        .mockResolvedValueOnce(null)                                  // 首次: 无
        .mockResolvedValueOnce({ localpart: 'u-6e8b21f0', display_name: null }), // 冲突后 re-query: 有
      insertAddress: vi.fn().mockRejectedValueOnce(new Error('insertAddress: duplicate key')),
    };
    const lp = await ensureEmailAddress(dao as any, UID);
    expect(lp).toBe('u-6e8b21f0');
  });

  it('插入冲突且 re-query 仍无(跨用户 8hex 撞了)→ 用全 hex 重试', async () => {
    const dao = {
      getAddress: vi.fn()
        .mockResolvedValueOnce(null)   // 首次
        .mockResolvedValueOnce(null),  // 冲突后 re-query 仍无 → 真撞别的用户
      insertAddress: vi.fn()
        .mockRejectedValueOnce(new Error('insertAddress: duplicate key'))  // 短 localpart 撞
        .mockResolvedValueOnce(undefined),                                  // 全 hex 成功
    };
    const lp = await ensureEmailAddress(dao as any, UID);
    expect(lp).toBe('u-' + UID.replace(/-/g, ''));
    expect(dao.insertAddress).toHaveBeenLastCalledWith(UID, 'u-' + UID.replace(/-/g, ''), null);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @lingxi/gateway exec vitest run test/api/email-provision.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 `apps/gateway/src/api/email-provision.ts`**

```typescript
import type { EmailDao } from '../db/email-dao.js';

/** 默认 handle: u- + userId 去横线前 8 hex (与 NFS 子目录 / purchase.ts shortHash 同源)。 */
export const defaultLocalpart = (userId: string): string =>
  `u-${userId.replace(/-/g, '').slice(0, 8)}`;

/**
 * 确保该用户有一行 email_addresses, 返回其 localpart (幂等)。
 * - 已有 → 直接返回。
 * - 无 → 插默认 localpart; 若插入冲突(并发或跨用户 8hex 碰撞):
 *     re-query 若已存在(并发别人插好了)→ 返回; 否则用全 hex(=去横线 uuid, 必唯一)重试一次。
 * display_name 本期传 null (发信 From 名回落 config.email.fromDefaultName)。
 */
export const ensureEmailAddress = async (
  dao: Pick<EmailDao, 'getAddress' | 'insertAddress'>,
  userId: string,
): Promise<string> => {
  const existing = await dao.getAddress(userId);
  if (existing) return existing.localpart;

  const short = defaultLocalpart(userId);
  try {
    await dao.insertAddress(userId, short, null);
    return short;
  } catch {
    const again = await dao.getAddress(userId);
    if (again) return again.localpart;            // 并发: 别的请求替本 user 插好了
    const full = `u-${userId.replace(/-/g, '')}`; // 跨用户 8hex 撞 → 全 hex 必唯一
    await dao.insertAddress(userId, full, null);
    return full;
  }
};
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @lingxi/gateway exec vitest run test/api/email-provision.test.ts`
Expected: 全 PASS(4 passed)。

- [ ] **Step 5: 提交**

```bash
git add apps/gateway/src/api/email-provision.ts apps/gateway/test/api/email-provision.test.ts
git commit -m "feat(email): ensureEmailAddress 自动分配 handle (含冲突回退)"
```

---

### Task 5: entitlements 路由通用 `onEnable` 钩子

**Files:**
- Modify: `apps/gateway/src/api/entitlements.ts`(deps + makeHandler)
- Test: `apps/gateway/test/api/entitlements.test.ts`(追加)

- [ ] **Step 1: 追加 onEnable 测试**

在 `entitlements.test.ts` 的 `makeApp` 里把 deps 接受 `onEnable`(可选)并透传:

把 `makeApp` 的参数类型加一行 `onEnable?: ReturnType<typeof vi.fn>;`,并在 `buildEntitlementsRouter({...})` 里加 `onEnable: deps.onEnable,`。

然后在文件末尾追加一个 describe:

```typescript
describe('onEnable hook', () => {
  it('enable 成功后调用 onEnable(userId, feature)', async () => {
    const onEnable = vi.fn().mockResolvedValue(undefined);
    const app = makeApp({
      enable: vi.fn().mockResolvedValue({ changed: true }),
      disable: vi.fn(),
      listActive: vi.fn().mockResolvedValue(['email']),
      bumpTokenVersion: vi.fn().mockResolvedValue(1),
      restartContainer: vi.fn().mockResolvedValue(undefined),
      signTokenAndInject: vi.fn().mockResolvedValue(undefined),
      onEnable,
    });
    const res = await request(app).post('/api/entitlements/email/enable');
    expect(res.status).toBe(200);
    expect(onEnable).toHaveBeenCalledWith(USER_ID, 'email');
  });

  it('disable 不调用 onEnable', async () => {
    const onEnable = vi.fn();
    const app = makeApp({
      enable: vi.fn(), disable: vi.fn().mockResolvedValue({ changed: true }),
      listActive: vi.fn().mockResolvedValue([]),
      bumpTokenVersion: vi.fn().mockResolvedValue(2),
      restartContainer: vi.fn().mockResolvedValue(undefined),
      signTokenAndInject: vi.fn().mockResolvedValue(undefined),
      onEnable,
    });
    await request(app).post('/api/entitlements/cloud/disable');
    expect(onEnable).not.toHaveBeenCalled();
  });

  it('onEnable 抛错不影响 200(钩子失败仅记日志)', async () => {
    const onEnable = vi.fn().mockRejectedValue(new Error('boom'));
    const app = makeApp({
      enable: vi.fn().mockResolvedValue({ changed: true }),
      disable: vi.fn(),
      listActive: vi.fn().mockResolvedValue(['email']),
      bumpTokenVersion: vi.fn().mockResolvedValue(1),
      restartContainer: vi.fn().mockResolvedValue(undefined),
      signTokenAndInject: vi.fn().mockResolvedValue(undefined),
      onEnable,
    });
    const res = await request(app).post('/api/entitlements/email/enable');
    expect(res.status).toBe(200);
  });
});
```

> 设计说明:onEnable 失败不阻断装备(handle 缺失会在助手第一次 `email send` 时以 409 暴露,且下次装备/resync 会再 ensure)。但失败要 `console.error` 记下。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @lingxi/gateway exec vitest run test/api/entitlements.test.ts`
Expected: 新 describe FAIL —— onEnable 未实现。

- [ ] **Step 3: 实现 onEnable**

`apps/gateway/src/api/entitlements.ts` 的 `EntitlementsRouterDeps` 接口追加:

```typescript
  /** enable 成功后的可选副作用钩子(如 email 自动分配 handle)。失败不阻断装备。 */
  onEnable?: (userId: string, feature: string) => Promise<void>;
```

在 `makeHandler` 里,`enable` 分支成功拿到 `active` 之前/之后均可,但要在确定 `kind === 'enable'` 且 DB enable 已完成后调用。最简单:在 `await deps.signTokenAndInject(...)` 之后、构造 `body` 之前,加:

```typescript
      if (kind === 'enable' && deps.onEnable) {
        try {
          await deps.onEnable(userId, feature);
        } catch (err) {
          console.error(`[entitlements] onEnable hook failed for ${userId}/${feature}:`, err);
        }
      }
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @lingxi/gateway exec vitest run test/api/entitlements.test.ts`
Expected: 全 PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/gateway/src/api/entitlements.ts apps/gateway/test/api/entitlements.test.ts
git commit -m "feat(entitlements): 通用 onEnable 钩子 (enable 成功后副作用, 失败不阻断)"
```

---

### Task 6: index.ts 接线 —— emailDao 上移 + onEnable 接 ensureEmailAddress

**Files:**
- Modify: `apps/gateway/src/index.ts`(约 159-196)

- [ ] **Step 1: 上移 emailDao 构造 + 接 onEnable**

当前结构(简化):

```typescript
    app.use(buildEntitlementsRouter({
      entitlements: entitlementsDao,
      restartContainer,
      signTokenAndInject: signAndInject,
      sessionMw,
    }));
    ...
    // 邮件能力 (B1): ...
    {
      const emailDao = makeEmailDao(sbResolved);
      ...
      app.use(buildEmailRouter({ dao: emailDao, ... }));
    }
```

改为:**先**构造 `emailDao`,把它同时用于 `onEnable` 和 email 路由。即在 `buildEntitlementsRouter` 调用**之前**加:

```typescript
    // emailDao 提前构造: entitlements onEnable 钩子(email 自动分配 handle)与下方 email 路由共用。
    const emailDao = makeEmailDao(sbResolved);
```

`buildEntitlementsRouter({...})` 的 deps 里追加:

```typescript
    app.use(buildEntitlementsRouter({
      entitlements: entitlementsDao,
      restartContainer,
      signTokenAndInject: signAndInject,
      sessionMw,
      onEnable: async (userId, feature) => {
        if (feature === 'email') {
          await ensureEmailAddress(emailDao, userId);
        }
      },
    }));
```

下方 email 路由块里**删掉**重复的 `const emailDao = makeEmailDao(sbResolved);`(改用上面那个),其余不变。

顶部 import 追加:

```typescript
import { ensureEmailAddress } from './api/email-provision.js';
```

- [ ] **Step 2: 类型检查 + 全量 gateway 测试**

Run: `pnpm --filter @lingxi/gateway build && pnpm --filter @lingxi/gateway exec vitest run`
Expected: build 无类型错误;测试全 PASS(B1 的 email.test.ts、本期新增的都过)。

- [ ] **Step 3: 提交**

```bash
git add apps/gateway/src/index.ts
git commit -m "feat(gateway): email 装备时经 onEnable 自动分配 handle (emailDao 上移共用)"
```

---

### Task 7: web —— IconMail + email 能力卡

**Files:**
- Modify: `apps/web/src/lib/icons.tsx`
- Modify: `apps/web/src/lib/capabilities.tsx`

- [ ] **Step 1: 加 IconMail**

`apps/web/src/lib/icons.tsx` 在 `IconMessage` 附近追加(用与其它 `wrap(...)` 图标一致的写法):

```typescript
export const IconMail = wrap('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>');
```

- [ ] **Step 2: 在 capabilities.tsx 注册 email 能力卡**

`apps/web/src/lib/capabilities.tsx` 顶部 import 把 `IconMail` 加进来:

```typescript
import { IconGlobe, IconFile, IconMessage, IconFolder, IconMail } from './icons.js';
```

在 `CAPABILITIES` 数组里 `cloud` 之后追加一条(removable + inMarket,**无 desktopApp** —— 无收件箱 UI):

```typescript
  {
    id: 'email', name: '邮件', icon: <IconMail size={22} color="var(--accent)" />,
    blurb: '给助理一个专属邮箱，可代收代发业务邮件（在对话里让它读信/回信）',
    price: 0, removable: true, inMarket: true,
    enableCopy: {
      title: '邮件',
      desc: '给助理一个专属邮箱地址，第三方可直接发邮件给它，你也可转发业务邮件进来。',
      lines: [
        '价格: 免费（后续可能收费）',
        '装备后系统会自动分配一个邮箱地址',
        '收到邮件不会主动通知，在对话里让助理「看看新邮件」即可',
      ],
    },
    disableCopy: {
      title: '退订邮件',
      desc: '退订后：',
      lines: ['• 助理不再能收发邮件', '• 已收到的邮件记录保留，重新装备后可继续访问'],
    },
  },
```

> 注意:`email` id 必须与 `MANAGEABLE_FEATURES` 里的 `'email'` 一致(Task 8 的测试会强制);无 `desktopApp` 字段(邮件无桌面 app)。

- [ ] **Step 3: build web 确认无类型/编译错误**

Run: `pnpm --filter @lingxi/web build`
Expected: 成功(market tab 现在会多出"邮件"卡,装备走通用 CapabilityEquip)。

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/lib/icons.tsx apps/web/src/lib/capabilities.tsx
git commit -m "feat(web): 注册「邮件」能力卡 (removable, 无桌面 app) + IconMail"
```

---

### Task 8: web 防漂移测试(catalog ↔ MANAGEABLE_FEATURES)

**Files:**
- Create: `apps/web/src/lib/capabilities.test.ts`

- [ ] **Step 1: 写防漂移测试**

```typescript
import { describe, it, expect } from 'vitest';
import { MANAGEABLE_FEATURES } from '@lingxi/shared';
import { CAPABILITIES } from './capabilities.js';

describe('catalog ↔ MANAGEABLE_FEATURES 不漂移', () => {
  it('所有 removable 能力 id 集合 === MANAGEABLE_FEATURES', () => {
    const removable = CAPABILITIES.filter((c) => c.removable).map((c) => c.id).sort();
    const managed = [...MANAGEABLE_FEATURES].sort();
    expect(removable).toEqual(managed);
  });

  it('进市场的能力都是 removable(基线能力不进市场)', () => {
    for (const c of CAPABILITIES.filter((c) => c.inMarket)) {
      expect(c.removable).toBe(true);
    }
  });

  it('removable 能力必带 enableCopy + disableCopy', () => {
    for (const c of CAPABILITIES.filter((c) => c.removable)) {
      expect(c.enableCopy).toBeTruthy();
      expect(c.disableCopy).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: 运行确认通过**

Run: `pnpm --filter @lingxi/web exec vitest run src/lib/capabilities.test.ts`
Expected: 全 PASS(cloud + email 两条 removable,正好等于 MANAGEABLE_FEATURES)。
若 FAIL,说明 catalog 与 shared 不一致 —— 这正是该测试要抓的漂移。

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/lib/capabilities.test.ts
git commit -m "test(web): catalog ↔ MANAGEABLE_FEATURES 防漂移断言"
```

---

### Task 9: bicep 补 email env(env 三处守则第三处)+ README KV 占位

**Files:**
- Modify: `infra/bicep/main.bicep:303-335`(appSettings)
- Modify: `infra/README.md`(KV secret 设置清单)

- [ ] **Step 1: 在 main.bicep appSettings 追加 email 五项**

`infra/bicep/main.bicep` 的 `appSettings` 资源 `properties` 里,在 `DASHSCOPE_API_KEY` 那行之后追加:

```bicep
    // 邮件能力 (子项 B)。prod 暂留 fake (Postmark 域名/DNS 验证完成前不真收发, 见 spec §八);
    // 域名+DKIM+入站 webhook 就绪后把 EMAIL_PROVIDER 改 'postmark' + 填两个 KV secret 即可。
    EMAIL_PROVIDER: 'fake'
    EMAIL_DOMAIN: 'mail.localhost'
    EMAIL_FROM_DEFAULT_NAME: '灵犀助理'
    POSTMARK_INBOUND_WEBHOOK_SECRET: '@Microsoft.KeyVault(VaultName=${kv.name};SecretName=postmark-inbound-webhook-secret)'
    POSTMARK_SERVER_TOKEN: '@Microsoft.KeyVault(VaultName=${kv.name};SecretName=postmark-server-token)'
```

> 这两个 KV 引用必须有对应 secret 才能 resolve(否则 App Service 会把字面量当值,known-issues #9 相关)。下一步在 README 加占位 secret 设置说明(允许空值,与 dashscope 同款)。

- [ ] **Step 2: 在 infra/README.md 的 KV secret 清单追加两行**

找到 `az keyvault secret set ... dashscope-api-key ...` 那行(标了"可填空字符串占位"),其后追加:

```bash
az keyvault secret set --vault-name $KV --name postmark-inbound-webhook-secret --value "$(openssl rand -hex 24)"  # 入站 webhook Basic-Auth; 与 Postmark inbound URL 内嵌密码一致
az keyvault secret set --vault-name $KV --name postmark-server-token --value ""   # Postmark 发信 token; 暂 provider=fake 可填空占位, 切 postmark 时再填
```

- [ ] **Step 3: bicep 语法自检(不实际部署)**

Run: `az bicep build --file infra/bicep/main.bicep --stdout > /dev/null && echo OK`
Expected: 打印 `OK`(无语法错误)。
(若本机无 az/bicep CLI,跳过此步,改人工核对缩进/引号与相邻条目一致。)

- [ ] **Step 4: 提交**

```bash
git add infra/bicep/main.bicep infra/README.md
git commit -m "infra(email): bicep appSettings 补 email env (三处守则) + README KV 占位"
```

---

## Self-Review 检查点(实现者执行完九个 Task 后)

- [ ] **Spec 覆盖**:spec §七(provisioning 分配 handle)→ Task 3/4/5/6 自动分配实现(自选 handle 按用户决策后置);§九 防漂移 → Task 1/2/8(shared 单一来源 + 测试);能力卡 §一决策"removable:true, desktopApp:无" → Task 7;env 三处守则 §八 → Task 9(bicep 第三处)。
- [ ] **单一来源**:`ALLOWED_FEATURES` 和 web removable 能力**都**绑 `MANAGEABLE_FEATURES`,加新能力只改 shared + catalog,测试兜底。
- [ ] **装备流程没被 special-case**:onEnable 是通用钩子,handler 不认识 'email';只有 index.ts 接线时才把 'email' → ensureEmailAddress。前端 CapabilityEquip 零改动。
- [ ] **类型一致**:`MANAGEABLE_FEATURES`(shared)/ `defaultLocalpart`/`ensureEmailAddress`(email-provision)/ `insertAddress`(email-dao)/ `onEnable`(entitlements deps)签名前后一致。
- [ ] **handle 唯一性**:默认 8hex,PK 兜底 + 冲突回退全 hex;并发 re-query。display_name=null(回落 config 名)。
- [ ] **既有测试翻转**:`email NOT allowed→404` 已改为 `email allowed→200`,不是新增重复用例。

## 端到端冒烟(subagent-driven 最终评审后由协调者跑,dev-fake)

1. 起本地 supabase(54422)+ 本地 gateway(`EMAIL_PROVIDER=fake`)。
2. 用一个本地用户 session 调 `POST /api/entitlements/email/enable` → 期望 200,且 DB `email_addresses` 多出该 user 的 `u-<8hex>` 行(onEnable 生效)。
3. 用该 user 的容器 token 调 `GET /api/email/list` → 200 空列表(entitlement 已 active)。
4. 调 `POST /api/email/send`(fake provider)→ 200,不再 409(handle 已分配)。
5. web `pnpm --filter @lingxi/web build` 后市场出现「邮件」卡;装备走通用流程。
6. 全量:`pnpm --filter @lingxi/gateway exec vitest run` + `pnpm --filter @lingxi/web exec vitest run` 全绿。
