# 助理身份（起名 + 真实邮箱）与 IM 绑定 Hub 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在激活助理时给它起名，名字作为身份贯穿全产品，并据名字生成**真实**专属邮箱（拼音 local part + 碰撞后缀，env 域名）；同时把"绑定微信"改造成可扩展的"IM 绑定 Hub"（本轮只有微信是真绑定，飞书留即将上线占位卡）。

**Architecture:**
- 助理名持久化：`container_mapping.assistant_name` 一列，购买时随 `PurchaseRequest` 写入，`StatusResponse` 读出，前端 `assistantAtom` 持有，`useAssistantName()` 全局读取（缺省回退 `灵犀`）。
- **邮箱方案 A（真实，本轮一步到位）**：local part = `拼音(名字)`（无声调、空格转连字符、英数小写），碰撞按后缀 `-2/-3/…` 去重、最终兜底带 userId 短 hash 保证唯一。生成在**购买时**（名字一确定就分配，是助理身份的一部分，不再等"装备邮件能力"）。域名取 env `EMAIL_DOMAIN`（dev `mail.localhost` / prod `mail.laifu.uncagedai.org` / test 部署传 `test-mail.laifu.uncagedai.org`）。
- **拼音规则收敛到 `packages/shared`**：base local part 派生函数前后端共用（pinyin-pro 进 shared 依赖），杜绝漂移；碰撞后缀是后端独有（要查库）。前端实时预览 = `base@域名`（域名经 `AuthMeResponse.email_domain` 下发）；真实邮箱（带后缀）由后端算好放进 `StatusResponse.assistant_email`，身份卡显示这个真实值。
- IM Hub 由 `IM_PROVIDERS` 代码 config 列表驱动（**不加表**）：加一个 IM = 加一条配置 + 一个图标。微信复用现有真实扫码 API（抽成 `useWechatBind` hook），飞书 = `coming_soon` 占位卡。绑定状态收敛到 `imBindingsAtom`，单一 N 源，数据源仍是各 IM 自己的 API。
- 顺手建轻量 `toastAtom` + `ToastHost`，替换关键路径的 `window.alert/confirm`。

**Tech Stack:** React 19 + 自研 atom（`src/atom`）+ 纯 CSS + vitest/jsdom/testing-library；后端 Express + Drizzle(PG)；`pinyin-pro`（新增到 `@lingxi/shared`，前后端共用）、`qrcode.react`（已装）。

**关键约束（来自 CLAUDE.md / 仓库现状）：**
- 不写 `NODE_ENV` 分支；差异靠 env 值切。`EMAIL_DOMAIN` 已存在于三处（`apps/gateway/.env.example` + `apps/gateway/src/config.ts` + `infra/bicep/main.bicep`），本计划不新增 env，只新增契约字段（shared → gateway → 前端三处同步）。
- 邮箱 local part 是 `email_addresses` 表主键 + cloudflare-email-worker 入站路由键。改其生成规则要保证**唯一**与**幂等**，且不动既有存量地址（已分配的 `u-<hash>` 行保持不变）。
- 交付前必须真跑 `pnpm dev` 冒烟；async handler 必包 try/catch。
- `apps/web` 的 `pnpm lint`（`tsc --noEmit`）baseline 就红，**不当门**；门用 `pnpm --filter @lingxi/web test` + `build`。
- `apps/web test` baseline 有 **2 个文件预先挂**：`test/CapabilityAction.test.tsx`、`test/ManageApp.test.tsx`（import 已删的 `entitlements-context.js`）。本计划 Task 16 重写 `ManageApp.test.tsx`；`CapabilityAction.test.tsx` 不在范围，保持已知红。

---

## File Structure

**共享层 / 契约（Phase 0）**
- Create `packages/shared/src/assistant.ts` + `.test.ts` — 名字校验 + 拼音 base local part（前后端共用）
- Modify `packages/shared/src/index.ts`、`packages/shared/package.json`（加 pinyin-pro）
- Modify `packages/shared/src/types.ts` — `ContainerMapping` 加 `assistant_name`
- Modify `packages/shared/src/contracts.ts` — `PurchaseRequest`/`StatusResponse`/`AuthMeResponse` 加字段
- Modify `packages/db/src/schema.ts` + `packages/db/drizzle/000X_*.sql`

**后端（Phase 0）**
- Modify `apps/gateway/src/api/email-provision.ts` — local part 改名字派生 + 碰撞后缀
- Modify `apps/gateway/src/db/container-mapping-dao.ts` — insert/toMapping 加 `assistant_name`
- Modify `apps/gateway/src/api/purchase.ts` — 校验+写名字+分配邮箱
- Modify `apps/gateway/src/api/status.ts` — 返回 `assistant_name` + `assistant_email`
- Modify `apps/gateway/src/auth/user-view.ts` — `toMeResponse` 加 `email_domain`

**前端基础（Phase 0）**
- Create `apps/web/src/lib/assistantEmail.ts` + `.test.ts` — 预览邮箱（包 shared base + 域名）
- Create `apps/web/src/states/assistant.atom.ts` — `{name,email}` + `useAssistantName`
- Create `apps/web/src/states/toast.atom.ts` + `.test.ts`、`apps/web/src/desktop/ToastHost.tsx`
- Modify `apps/web/src/lib/icons.tsx` — `IconWechat`/`IconFeishu`
- Create `apps/web/src/apps/im/providers.tsx` + `test/...`、`apps/web/src/states/imBindings.atom.ts`
- Modify `apps/web/src/lib/api.ts` — `purchase()` 带名字

**改动二 · 起名（Phase 1）**
- Modify `apps/web/src/onboarding/Onboarding.tsx` + `apps/web/test/Onboarding.test.tsx`
- Modify `Desktop.tsx`、`Dock.tsx`、`Menubar.tsx`、`apps/chat/Conversation.tsx`、`apps/chat/Composer.tsx`

**改动一 · IM Hub（Phase 2）**
- Create `apps/web/src/apps/im/useWechatBind.ts`、`IMProviderCard.tsx`、`IMBindDialog.tsx`、`IMHub.tsx`
- Modify `Desktop.tsx`（窗口 `wechat`→`im`）、`apps/manage/ManageApp.tsx`、`test/ManageApp.test.tsx`
- Delete `apps/web/src/apps/wechat/WechatApp.tsx`

---

# Phase 0 · 基础（共享层 + 后端字段/邮箱 + 前端纯逻辑）

## Task 1: 共享层 — 名字校验 + 拼音 base local part（前后端单一真源）

**Files:**
- Create: `packages/shared/src/assistant.ts`
- Create: `packages/shared/src/assistant.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/package.json`

- [ ] **Step 1: 给 shared 装 pinyin-pro**

Run: `pnpm --filter @lingxi/shared add pinyin-pro`
Expected: `packages/shared/package.json` `dependencies` 出现 `pinyin-pro`（shared 原本只有 devDeps，这是首个运行时依赖）。

- [ ] **Step 2: 写失败测试（校验 + 拼音 base 规则）**

```ts
// packages/shared/src/assistant.test.ts
import { describe, it, expect } from 'vitest';
import { isValidAssistantName, assistantLocalpartBase, MAX_ASSISTANT_NAME_LEN } from './assistant.js';

describe('isValidAssistantName', () => {
  it('非空 <=24 → true；空/纯空白/超长 → false', () => {
    expect(isValidAssistantName('灵犀')).toBe(true);
    expect(isValidAssistantName('x'.repeat(MAX_ASSISTANT_NAME_LEN))).toBe(true);
    expect(isValidAssistantName('')).toBe(false);
    expect(isValidAssistantName('   ')).toBe(false);
    expect(isValidAssistantName('x'.repeat(MAX_ASSISTANT_NAME_LEN + 1))).toBe(false);
    // @ts-expect-error 故意传错类型
    expect(isValidAssistantName(undefined)).toBe(false);
  });
});

describe('assistantLocalpartBase', () => {
  it('空 → 空串', () => { expect(assistantLocalpartBase('')).toBe(''); expect(assistantLocalpartBase('  ')).toBe(''); });
  it('英文数字直显并小写', () => { expect(assistantLocalpartBase('Aria')).toBe('aria'); });
  it('中文转拼音（无声调、音节相连）', () => {
    expect(assistantLocalpartBase('灵犀')).toBe('lingxi');
    expect(assistantLocalpartBase('张小明')).toBe('zhangxiaoming');
  });
  it('空格 → 连字符', () => {
    expect(assistantLocalpartBase('小助 7')).toBe('xiaozhu-7');
    expect(assistantLocalpartBase('Aria 小助')).toBe('aria-xiaozhu');
  });
  it('全 emoji / 无可用字符 → 空串（兜底由调用方决定）', () => {
    expect(assistantLocalpartBase('🎉🎉')).toBe('');
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @lingxi/shared test`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现**

```ts
// packages/shared/src/assistant.ts
import { pinyin } from 'pinyin-pro';

/** 助理名最大长度（前端 maxLength + 后端兜底共用）。 */
export const MAX_ASSISTANT_NAME_LEN = 24;

/** 名字是否合法：trim 后非空且不超长。前端门控 + 后端兜底共用。 */
export const isValidAssistantName = (name: unknown): name is string => {
  if (typeof name !== 'string') return false;
  const t = name.trim();
  return t.length >= 1 && t.length <= MAX_ASSISTANT_NAME_LEN;
};

/**
 * 名字 → 邮箱 local part 的 **base**（不含碰撞后缀，前后端单一真源）。
 * - 按空白切段，段间连字符；
 * - 段内：中文→拼音(无声调、相连)，ASCII 取 [a-z0-9] 小写，其余丢弃；
 * - 空输入 / 全被丢弃 → ''（兜底策略由调用方定：前端显示 —，后端用 u-hash）。
 */
export const assistantLocalpartBase = (name: string): string => {
  const trimmed = name.trim();
  if (!trimmed) return '';
  const segments = trimmed.split(/\s+/).map((seg) => {
    const py = pinyin(seg, { toneType: 'none', type: 'array' }).join('');
    return py.toLowerCase().replace(/[^a-z0-9]/g, '');
  }).filter(Boolean);
  return segments.join('-');
};
```

- [ ] **Step 5: 导出**

`packages/shared/src/index.ts` 末尾加：`export * from './assistant.js';`

- [ ] **Step 6: 跑测试 + build 确认**

Run: `pnpm --filter @lingxi/shared test && pnpm --filter @lingxi/shared build`
Expected: PASS；`dist/assistant.js` 产出。若 `张小明`/`小助` 拼音与预期不符，以 pinyin-pro 实际输出微调期望值（空格→连字符、英文小写、空串三条规则必须保持）。

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/assistant.ts packages/shared/src/assistant.test.ts packages/shared/src/index.ts packages/shared/package.json pnpm-lock.yaml
git commit -m "feat(shared): 名字校验 + 拼音 base localpart(前后端共用) + pinyin-pro"
```

---

## Task 2: 契约 + DB schema — `assistant_name` + 邮箱字段

**Files:**
- Modify: `packages/shared/src/types.ts:16-28`
- Modify: `packages/shared/src/contracts.ts:61-90`
- Modify: `packages/db/src/schema.ts:35-49`

- [ ] **Step 1: `ContainerMapping` 加 `assistant_name`**

`types.ts` `policy_hash` 行后加：

```ts
  policy_hash: string | null;   // ACA 当前已应用的 POLICY_HASH; NULL = 从未 reconcile
  assistant_name: string | null;  // 用户给助理起的名字（购买时写入）; 存量行为 NULL
}
```

- [ ] **Step 2: `PurchaseRequest` 带名字**

`contracts.ts` 第 61-63 行替换：

```ts
export interface PurchaseRequest {
  assistant_name: string;   // 用户给助理起的名字（必填，trim 后 1..24 字符）
}
```

- [ ] **Step 3: `StatusResponse` 加 `assistant_name` + `assistant_email`**

`contracts.ts` `StatusResponse` 在 `container_token_version` 后加：

```ts
  container_token_version: number;
  assistant_name: string | null;      // container_mapping.assistant_name
  assistant_email: string | null;     // 真实专属邮箱（含碰撞后缀）= localpart@EMAIL_DOMAIN; 未分配则 null
}
```

- [ ] **Step 4: `AuthMeResponse` 加 `email_domain`**

`contracts.ts` `AuthMeResponse`（第 83-90 行）末尾加：

```ts
  avatar_url: string | null;
  email_domain: string;        // 当前部署的助理邮箱域名（前端实时预览拼）；= 后端 EMAIL_DOMAIN
}
```

- [ ] **Step 5: DB schema 加列**

`schema.ts` `containerMapping` 在 `policy_hash` 后加：

```ts
  policy_hash: text('policy_hash'),
  assistant_name: text('assistant_name'),
});
```

（`email_addresses` 表已存在，无需改。）

- [ ] **Step 6: build shared + 生成迁移**

Run: `pnpm --filter @lingxi/shared build && cd packages/db && pnpm db:generate`
Expected: 新增 `packages/db/drizzle/000X_*.sql`，仅 `ALTER TABLE "container_mapping" ADD COLUMN "assistant_name" text;`。打开确认无意外 DROP。

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/contracts.ts packages/db/src/schema.ts packages/db/drizzle
git commit -m "feat(shared,db): assistant_name + assistant_email + email_domain 契约/列"
```

---

## Task 3: 后端 — 邮箱名字派生 + 购买分配 + status/me 返回

**Files:**
- Modify: `apps/gateway/src/api/email-provision.ts`
- Modify: `apps/gateway/src/db/container-mapping-dao.ts:10-52`
- Modify: `apps/gateway/src/api/purchase.ts`
- Modify: `apps/gateway/src/api/status.ts`
- Modify: `apps/gateway/src/auth/user-view.ts`

- [ ] **Step 1: email-provision 改为名字派生 + 碰撞后缀（幂等、保唯一）**

`apps/gateway/src/api/email-provision.ts` 替换为：

```ts
import { dao } from '../db/index.js';
import { assistantLocalpartBase } from '@lingxi/shared';

/** 旧默认 handle（无名字时兜底，与 NFS 子目录 / shortHash 同源）。 */
export const defaultLocalpart = (userId: string): string =>
  `u-${userId.replace(/-/g, '').slice(0, 8)}`;

/**
 * 确保该用户有一行 email_addresses，返回其 localpart（幂等）。
 * 规则（方案 A）：local part = 拼音(assistantName) 的 base；同名碰撞按 -2/-3/… 去重，
 * 最终兜底带 userId 短 hash 保证唯一。无名字 / base 为空 → 退回 u-<hash>。
 * localpart 是表主键 + 入站路由键，必须唯一；多 candidate 顺序 insert，撞了试下一个。
 */
export const ensureEmailAddress = async (userId: string, assistantName?: string | null): Promise<string> => {
  const existing = await dao.email.getAddress(userId);
  if (existing) return existing.localpart;            // 幂等：已分配不变

  let name = assistantName ?? null;
  if (name == null) {
    const cm = await dao.containerMapping.getByUserId(userId);
    name = cm?.assistant_name ?? null;
  }

  const base = (name ? assistantLocalpartBase(name) : '') || defaultLocalpart(userId);
  const short = userId.replace(/-/g, '').slice(0, 6);
  const candidates = [base, `${base}-2`, `${base}-3`, `${base}-4`, `${base}-5`, `${base}-${short}`];

  for (const c of candidates) {
    try {
      await dao.email.insertAddress(userId, c, name);   // display_name = 名字（出站 From 友好）
      return c;
    } catch {
      // localpart 被别的用户占了 → 试下一个 candidate
    }
  }
  // 理论到不了（最后 candidate 带 userId hash 必唯一）；再兜底带全 hash
  const full = `${base}-${userId.replace(/-/g, '')}`;
  await dao.email.insertAddress(userId, full, name);
  return full;
};
```

> 注意：确认 `dao.email.insertAddress(userId, localpart, display_name)` 现签名是否第三参 display_name；若不是，按现签名调整。原文件第三参传 `null`，这里改传 `name`。

- [ ] **Step 2: DAO insert 类型 + values + toMapping 加 `assistant_name`**

`container-mapping-dao.ts`：
- 第 11-17 行 `insert` 入参类型加 `assistant_name: string;`
- 第 44-52 行 `.values({...})` 加 `assistant_name: row.assistant_name,`
- `toMapping`（27-39 行）`policy_hash` 后加 `assistant_name: r.assistant_name ?? null,`

- [ ] **Step 3: purchase 校验 + 写名字 + 分配邮箱**

`apps/gateway/src/api/purchase.ts`：
- 第 2 行 import 改：`import { isValidAssistantName, type PurchaseRequest, type PurchaseResponse } from '@lingxi/shared';`
- 顶部加：`import { ensureEmailAddress } from './email-provision.js';`
- 第 13 行 `const userId` 后插入校验 + 取名字：

```ts
    const userId = req.session!.user_id;
    const { assistant_name } = (req.body ?? {}) as Partial<PurchaseRequest>;
    if (!isValidAssistantName(assistant_name)) {
      return res.status(400).json({ error: 'invalid assistant_name' });
    }
    const assistantName = assistant_name.trim();
    const containerName = containerNameFor(userId);
```

- insert（第 18-24 行）加 `assistant_name: assistantName,`
- 第 35-36 行（拿到 data、set cache）后，分配邮箱（非致命，包 try/catch）：

```ts
    const data = await dao.containerMapping.getByUserId(userId);
    if (data) dao.cache.set(data);

    // 起名即分配专属邮箱（名字派生 localpart）；失败不阻断激活
    try {
      await ensureEmailAddress(userId, assistantName);
    } catch (err) {
      console.error(`[purchase] email alloc failed for ${userId}:`, err);
    }
```

- [ ] **Step 4: status 返回 `assistant_name` + 真实 `assistant_email`**

`apps/gateway/src/api/status.ts`：
- 顶部加：`import { config } from '../config.js';`（确认 config 导出名/路径，与仓库一致）
- `Promise.all`（第 18-22 行）加一项取邮箱地址：

```ts
    const [desired, observed, tv, addr] = await Promise.all([
      dao.entitlements.listActive(userId),
      dao.observedState.get(userId),
      dao.entitlements.getTokenVersion(userId),
      dao.email.getAddress(userId),
    ]);
```

- `body`（24-32 行）加：

```ts
      container_token_version: tv ?? 0,
      assistant_name: row.assistant_name,
      assistant_email: addr ? `${addr.localpart}@${config.email.domain}` : null,
    };
```

- [ ] **Step 5: toMeResponse 加 `email_domain`**

`apps/gateway/src/auth/user-view.ts`：顶部 import `config`，`toMeResponse`（16-23 行）加：

```ts
  avatar_url: row.avatar_url,
  email_domain: config.email.domain,
});
```

- [ ] **Step 6: gateway 编译 + 现有测试绿**

Run: `pnpm --filter @lingxi/gateway lint && pnpm --filter @lingxi/gateway test`
Expected: 无 TS 错误；现有测试全绿。provisioning 相关测试若构造 `containerMapping.insert` 或断 `toMeResponse`，按需补 `assistant_name`/`email_domain` 字段（本步一并修）。

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/src/api/email-provision.ts apps/gateway/src/db/container-mapping-dao.ts apps/gateway/src/api/purchase.ts apps/gateway/src/api/status.ts apps/gateway/src/auth/user-view.ts apps/gateway/test
git commit -m "feat(gateway): 名字派生真实邮箱 + 购买分配 + status/me 下发"
```

---

## Task 4: 前端邮箱预览工具（包 shared base + 域名）

**Files:**
- Create: `apps/web/src/lib/assistantEmail.ts`
- Create: `apps/web/src/lib/assistantEmail.test.ts`

前端**只做实时预览**（无后缀，乐观）；真实带后缀地址走 `StatusResponse.assistant_email`。拼音 base 复用 shared，域名由调用方传入（来自 `AuthMeResponse.email_domain`）。

- [ ] **Step 1: 写失败测试**

```ts
// apps/web/src/lib/assistantEmail.test.ts
import { describe, it, expect } from 'vitest';
import { assistantEmailPreview } from './assistantEmail.js';

const D = 'mail.laifu.uncagedai.org';

describe('assistantEmailPreview', () => {
  it('空名 → —@域名 占位', () => {
    expect(assistantEmailPreview('', D)).toBe(`—@${D}`);
    expect(assistantEmailPreview('   ', D)).toBe(`—@${D}`);
  });
  it('正常 → base@域名', () => {
    expect(assistantEmailPreview('灵犀', D)).toBe(`lingxi@${D}`);
    expect(assistantEmailPreview('Aria', D)).toBe(`aria@${D}`);
  });
  it('全 emoji → assistant 兜底', () => {
    expect(assistantEmailPreview('🎉', D)).toBe(`assistant@${D}`);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @lingxi/web test assistantEmail`
Expected: FAIL

- [ ] **Step 3: 实现（复用 shared base）**

```ts
// apps/web/src/lib/assistantEmail.ts
import { assistantLocalpartBase } from '@lingxi/shared';

/**
 * 激活页实时预览邮箱（无碰撞后缀，乐观）。base 复用 shared 与后端同源；
 * 域名来自后端 AuthMeResponse.email_domain。空名显示 — 占位，全丢弃显示 assistant。
 */
export const assistantEmailPreview = (name: string, domain: string): string => {
  const base = assistantLocalpartBase(name);
  const local = name.trim() ? (base || 'assistant') : '—';
  return `${local}@${domain}`;
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @lingxi/web test assistantEmail`
Expected: PASS（拼音差异以 pinyin-pro 为准微调）

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/assistantEmail.ts apps/web/src/lib/assistantEmail.test.ts
git commit -m "feat(web): 邮箱实时预览(复用 shared base + 后端域名)"
```

---

## Task 5: 前端 `assistantAtom`（name + 真实 email）+ `useAssistantName`

**Files:**
- Create: `apps/web/src/states/assistant.atom.ts`
- Modify: `apps/web/src/lib/api.ts:73-74`

- [ ] **Step 1: `purchase()` 接受名字**

`api.ts`：第 11 行 import 加 `PurchaseRequest`（若缺）；第 73-74 行替换：

```ts
export const purchase = (body: PurchaseRequest): Promise<PurchaseResponse> =>
  json('/api/purchase', { method: 'POST', body: JSON.stringify(body) });
```

- [ ] **Step 2: 实现 atom（持有 name + 真实 email）**

```ts
// apps/web/src/states/assistant.atom.ts
import { useMemo } from 'react';
import { atom } from '../atom/index.js';
import * as api from '../lib/api.js';

export const DEFAULT_ASSISTANT_NAME = '灵犀';

export interface AssistantState {
  name: string | null;    // null = 未拿到/未购买
  email: string | null;   // 真实专属邮箱（含后缀），来自 status.assistant_email
}

interface AssistantActions {
  refresh: () => Promise<void>;
  setName: (name: string) => void;   // 激活成功乐观写名（email 等下次 refresh）
}

export const assistantAtom = atom<AssistantState, AssistantActions>(
  { name: null, email: null },
  (get, set) => {
    const refresh = async () => {
      try {
        const s = await api.status();
        set({ name: s?.assistant_name ?? null, email: s?.assistant_email ?? null });
      } catch { /* 401/网络错误：保持现状 */ }
    };
    const setName = (name: string) => set({ ...get(), name });
    void refresh();
    return { refresh, setName };
  },
);

/** 全局读助理显示名；缺省回退。 */
export const useAssistantName = (): string => {
  const [s] = assistantAtom.use();
  return useMemo(() => s.name?.trim() || DEFAULT_ASSISTANT_NAME, [s.name]);
};
```

- [ ] **Step 3: 编译确认**

Run: `pnpm --filter @lingxi/web build`
Expected: 无 TS 错误

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/states/assistant.atom.ts apps/web/src/lib/api.ts
git commit -m "feat(web): assistantAtom(name+真实email) + purchase 带名字"
```

---

## Task 6: 轻量 Toast（atom + Host）

**Files:**
- Create: `apps/web/src/states/toast.atom.ts`
- Create: `apps/web/src/states/toast.atom.test.ts`
- Create: `apps/web/src/desktop/ToastHost.tsx`

- [ ] **Step 1: 写 reducer 失败测试**

```ts
// apps/web/src/states/toast.atom.test.ts
import { describe, it, expect } from 'vitest';
import { pushToast, dismissToast } from './toast.atom.js';
import type { ToastItem } from './toast.atom.js';

describe('toast reducer', () => {
  it('pushToast 追加一条', () => {
    const next = pushToast([], '微信绑定成功', 'success');
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ msg: '微信绑定成功', kind: 'success' });
    expect(next[0].id).toBeTruthy();
  });
  it('dismissToast 按 id 移除', () => {
    const a: ToastItem = { id: '1', msg: 'a', kind: 'info' };
    const b: ToastItem = { id: '2', msg: 'b', kind: 'info' };
    expect(dismissToast([a, b], '1')).toEqual([b]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @lingxi/web test toast`
Expected: FAIL

- [ ] **Step 3: 实现 atom + reducer + 计时自消**

```ts
// apps/web/src/states/toast.atom.ts
import { atom } from '../atom/index.js';

export type ToastKind = 'success' | 'error' | 'info';
export interface ToastItem { id: string; msg: string; kind: ToastKind; }

const TTL_MS = 3000;
let seq = 0;

export const pushToast = (list: ToastItem[], msg: string, kind: ToastKind): ToastItem[] =>
  [...list, { id: `t${++seq}`, msg, kind }];
export const dismissToast = (list: ToastItem[], id: string): ToastItem[] =>
  list.filter((t) => t.id !== id);

interface ToastActions {
  show: (msg: string, kind?: ToastKind) => void;
  dismiss: (id: string) => void;
}

export const toastAtom = atom<ToastItem[], ToastActions>(
  [],
  (get, set) => {
    const dismiss = (id: string) => set(dismissToast(get(), id));
    const show = (msg: string, kind: ToastKind = 'success') => {
      const next = pushToast(get(), msg, kind);
      const id = next[next.length - 1].id;
      set(next);
      window.setTimeout(() => dismiss(id), TTL_MS);
    };
    return { show, dismiss };
  },
);

/** 组件里取 show：`const toast = useToast(); toast('已绑定')` */
export const useToast = (): ToastActions['show'] => {
  const [, actions] = toastAtom.use();
  return actions.show;
};
```

- [ ] **Step 4: 实现 ToastHost**

```tsx
// apps/web/src/desktop/ToastHost.tsx
import { toastAtom } from '../states/toast.atom.js';

const KIND_COLOR: Record<string, string> = { success: 'var(--ok)', error: 'var(--bad)', info: 'var(--accent)' };

export const ToastHost = () => {
  const [toasts, actions] = toastAtom.use();
  return (
    <div style={{ position: 'fixed', top: 38, right: 16, zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 8, pointerEvents: 'none' }}>
      {toasts.map((t) => (
        <div key={t.id} className="fade" onClick={() => actions.dismiss(t.id)}
          style={{ pointerEvents: 'auto', cursor: 'pointer', background: 'rgba(255,255,255,0.98)', color: 'var(--text)',
            borderLeft: `3px solid ${KIND_COLOR[t.kind] ?? 'var(--accent)'}`, borderRadius: 10, padding: '10px 14px',
            fontSize: 13, boxShadow: '0 10px 30px rgba(0,0,0,0.18), 0 0 0 1px rgba(0,0,0,0.06)', maxWidth: 320 }}>
          {t.msg}
        </div>
      ))}
    </div>
  );
};
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @lingxi/web test toast`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/states/toast.atom.ts apps/web/src/states/toast.atom.test.ts apps/web/src/desktop/ToastHost.tsx
git commit -m "feat(web): 轻量 toast (atom + ToastHost)"
```

---

## Task 7: IM 图标 + Provider 注册表

**Files:**
- Modify: `apps/web/src/lib/icons.tsx`
- Create: `apps/web/src/apps/im/providers.tsx`
- Create: `apps/web/test/providers.test.ts`

- [ ] **Step 1: 加两个品牌图标**

`apps/web/src/lib/icons.tsx` 末尾追加（沿用同文件 `IconProps` 签名）：

```tsx
export const IconWechat = ({ size = 18, color = 'currentColor' }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 4C5.1 4 2 6.6 2 9.8c0 1.8 1 3.4 2.6 4.5L4 17l2.6-1.3c.8.2 1.6.3 2.4.3" />
    <circle cx="7" cy="9" r=".6" fill={color} stroke="none" />
    <circle cx="11" cy="9" r=".6" fill={color} stroke="none" />
    <path d="M22 15.2c0-2.6-2.6-4.7-5.8-4.7s-5.8 2.1-5.8 4.7 2.6 4.7 5.8 4.7c.7 0 1.4-.1 2-.3L20.5 21l-.5-2c1.2-.9 2-2.2 2-3.8z" />
    <circle cx="14.5" cy="14.6" r=".5" fill={color} stroke="none" />
    <circle cx="17.8" cy="14.6" r=".5" fill={color} stroke="none" />
  </svg>
);

export const IconFeishu = ({ size = 18, color = 'currentColor' }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 17c3.5-1 6-3.2 8-7 1.6 2.4 3.6 3.6 6 4-3 2.6-7 4-11 4-1.2 0-2.2-.3-3-1z" />
    <path d="M5 9c2-2 4.5-3 7.5-3" />
  </svg>
);
```

- [ ] **Step 2: 写注册表失败测试**

```ts
// apps/web/test/providers.test.ts
import { describe, it, expect } from 'vitest';
import { IM_PROVIDERS } from '../src/apps/im/providers.js';

describe('IM_PROVIDERS', () => {
  it('id 唯一', () => {
    const ids = IM_PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('每张卡信息位齐全', () => {
    for (const p of IM_PROVIDERS) {
      expect(p.name).toBeTruthy();
      expect(p.brand).toMatch(/^#/);
      expect(p.brandWeak).toBeTruthy();
      expect(p.steps.length).toBe(3);
      expect(p.unboundDesc).toBeTruthy();
      expect(p.icon).toBeTruthy();
    }
  });
  it('微信 available、飞书 coming_soon', () => {
    expect(IM_PROVIDERS.find((p) => p.id === 'wechat')?.status).toBe('available');
    expect(IM_PROVIDERS.find((p) => p.id === 'feishu')?.status).toBe('coming_soon');
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @lingxi/web test providers`
Expected: FAIL

- [ ] **Step 4: 实现注册表**

```tsx
// apps/web/src/apps/im/providers.tsx
import type { ReactNode } from 'react';
import { IconWechat, IconFeishu } from '../../lib/icons.js';

export type IMProviderId = 'wechat' | 'feishu';
export type IMProviderStatus = 'available' | 'coming_soon';

export interface IMProvider {
  id: IMProviderId;
  name: string;
  brand: string;           // 主题色 hex
  brandWeak: string;       // 浅色容器底
  status: IMProviderStatus;
  icon: ReactNode;
  unboundDesc: string;
  bindTitlePrefix: string; // "用微信扫一扫绑定" — 渲染时拼助理名
  steps: [string, string, string];
}

export const IM_PROVIDERS: IMProvider[] = [
  {
    id: 'wechat', name: '微信', brand: '#07c160', brandWeak: '#07c1601f',
    status: 'available', icon: <IconWechat size={22} color="#07c160" />,
    unboundDesc: '绑定后在微信里直接给助理派活',
    bindTitlePrefix: '用微信扫一扫绑定',
    steps: ['打开微信 → 扫一扫', '扫描左侧二维码', '在微信里点确认授权'],
  },
  {
    id: 'feishu', name: '飞书', brand: '#3370ff', brandWeak: '#3370ff1f',
    status: 'coming_soon', icon: <IconFeishu size={22} color="#3370ff" />,
    unboundDesc: '绑定后在飞书里直接给助理派活',
    bindTitlePrefix: '用飞书扫一扫绑定',
    steps: ['打开飞书 → 扫一扫', '扫描二维码', '在飞书里点确认授权'],
  },
];
```

- [ ] **Step 5: 跑测试确认通过 + Commit**

Run: `pnpm --filter @lingxi/web test providers`（PASS）

```bash
git add apps/web/src/lib/icons.tsx apps/web/src/apps/im/providers.tsx apps/web/test/providers.test.ts
git commit -m "feat(web): IM provider 注册表 + 微信/飞书图标"
```

---

## Task 8: `imBindingsAtom` + `useIMCount`

**Files:**
- Create: `apps/web/src/states/imBindings.atom.ts`

- [ ] **Step 1: 实现（单一 N 源；只有微信真查）**

```ts
// apps/web/src/states/imBindings.atom.ts
import { useMemo } from 'react';
import { atom } from '../atom/index.js';
import { getMyWechatBind } from '../lib/api.js';
import type { IMProviderId } from '../apps/im/providers.js';

export type IMBindings = Partial<Record<IMProviderId, boolean>>;
interface IMBindingsActions { refresh: () => Promise<void>; }

export const imBindingsAtom = atom<IMBindings, IMBindingsActions>(
  {},
  (_get, set) => {
    const refresh = async () => {
      let wechat = false;
      try { wechat = (await getMyWechatBind()).bound; } catch { /* 网络错 → 未绑 */ }
      set({ wechat });
    };
    void refresh();
    return { refresh };
  },
);

export const useIMCount = (): number => {
  const [b] = imBindingsAtom.use();
  return useMemo(() => Object.values(b).filter(Boolean).length, [b]);
};
```

- [ ] **Step 2: 编译 + Commit**

Run: `pnpm --filter @lingxi/web build`（无错）

```bash
git add apps/web/src/states/imBindings.atom.ts
git commit -m "feat(web): imBindingsAtom + useIMCount(单一 N 源)"
```

---

# Phase 1 · 改动二：起名 + 邮箱预览 + 全局替换

## Task 9: 激活对话框 — 起名输入 + 实时邮箱预览 + 按钮门控

**Files:**
- Modify: `apps/web/src/onboarding/Onboarding.tsx`
- Modify: `apps/web/test/Onboarding.test.tsx`（**已存在且当前绿**，测旧行为；本任务改 Onboarding 会让它失败，必须整体重写为下方版本）

> 域名取自 `authAtom`（`AuthMeResponse.email_domain`，app 初始化已加载）；预览拼 `assistantEmailPreview(name, domain)`。组件测试放 `apps/web/test/`，import 走 `../src/...`。

- [ ] **Step 1: 重写既有组件行为测试**

整体替换 `apps/web/test/Onboarding.test.tsx`：

```tsx
// apps/web/test/Onboarding.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WithStore } from '../src/atom/index.js';
import * as api from '../src/lib/api.js';
import { Onboarding } from '../src/onboarding/Onboarding.js';

vi.mock('../src/lib/api.js', async (orig) => ({
  ...(await orig<typeof api>()),
  me: vi.fn().mockResolvedValue({ user_id: 'u1', provider: 'dev', external_id: 'x', email: null, nickname: 'n', avatar_url: null, email_domain: 'mail.laifu.uncagedai.org' }),
  status: vi.fn().mockResolvedValue(null),
  purchase: vi.fn().mockResolvedValue({ user_id: 'u1', status: 'provisioning' }),
}));

const renderIt = () => render(<WithStore><Onboarding onReady={() => {}} /></WithStore>);

describe('Onboarding 起名', () => {
  beforeEach(() => vi.clearAllMocks());

  it('名字为空时激活按钮 disabled', async () => {
    renderIt();
    expect(await screen.findByRole('button', { name: /确认支付并激活/ })).toBeDisabled();
  });

  it('输入名字 → 邮箱预览实时变化 + 按钮可点', async () => {
    renderIt();
    const input = await screen.findByPlaceholderText(/灵犀.*Aria.*小助/);
    fireEvent.change(input, { target: { value: 'Aria' } });
    expect(screen.getByText(/aria@mail\.laifu\.uncagedai\.org/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /确认支付并激活/ })).toBeEnabled();
  });

  it('点激活 → purchase 带 assistant_name', async () => {
    renderIt();
    const input = await screen.findByPlaceholderText(/灵犀.*Aria.*小助/);
    fireEvent.change(input, { target: { value: '灵犀' } });
    fireEvent.click(screen.getByRole('button', { name: /确认支付并激活/ }));
    expect(api.purchase).toHaveBeenCalledWith({ assistant_name: '灵犀' });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @lingxi/web test Onboarding`
Expected: FAIL

- [ ] **Step 3: 改 Onboarding**

`apps/web/src/onboarding/Onboarding.tsx`：
- import 追加：

```ts
import { assistantEmailPreview } from '../lib/assistantEmail.js';
import { assistantAtom } from '../states/assistant.atom.js';
import { authAtom } from '../states/auth.atom.js';
import { isValidAssistantName, MAX_ASSISTANT_NAME_LEN } from '@lingxi/shared';
```

- 组件内加 state / 域名 / 校验：

```ts
  const [name, setName] = useState('');
  const [, assistantActions] = assistantAtom.use();
  const [auth] = authAtom.use();
  const domain = auth.status === 'authenticated' ? auth.user.email_domain : 'mail.localhost';
  const nameValid = isValidAssistantName(name);
```

- `onPurchase` 改：

```ts
  const onPurchase = async () => {
    if (!nameValid) return;
    setSubmitting(true);
    try {
      await api.purchase({ assistant_name: name.trim() });
      assistantActions.setName(name.trim());
      setView({ mode: 'provisioning', step: '正在创建账户与订单', pct: 5 });
    } catch (e) {
      setView({ mode: 'failed', err: e instanceof Error ? e.message : '购买失败' });
    } finally {
      setSubmitting(false);
    }
  };
```

- `not-purchased` 视图（78-85 行）替换为起名区（标题"欢迎使用灵犀"第 73 行保留=产品品牌）：

```tsx
        {view.mode === 'not-purchased' && (
          <div style={{ textAlign: 'left' }}>
            <label style={{ fontSize: 13, fontWeight: 600 }}>
              给你的助理起个名字 <span style={{ color: 'var(--bad)' }}>*</span>
              <span className="dim" style={{ fontWeight: 400, marginLeft: 6 }}>必填</span>
            </label>
            <input className="input" autoFocus maxLength={MAX_ASSISTANT_NAME_LEN} value={name}
              onChange={(e) => setName(e.target.value)} placeholder="如：灵犀 / Aria / 小助"
              style={{ width: '100%', marginTop: 8 }} />
            <div className="dim" style={{ fontSize: 11.5, marginTop: 6, fontFamily: 'monospace' }}>
              专属邮箱预览：{assistantEmailPreview(name, domain)}
            </div>
            <div className="muted" style={{ fontSize: 12, margin: '16px 0 6px' }}>套餐 · MVP 阶段免费</div>
            <button className="btn btn-primary"
              style={{ width: '100%', padding: '12px 28px', fontSize: 14, marginTop: 10, opacity: nameValid ? 1 : 0.5 }}
              disabled={submitting || !nameValid} onClick={onPurchase}>
              {submitting ? '激活中…' : '确认支付并激活'}
            </button>
          </div>
        )}
```

- [ ] **Step 4: 跑测试确认通过 + Commit**

Run: `pnpm --filter @lingxi/web test Onboarding`（PASS）

```bash
git add apps/web/src/onboarding/Onboarding.tsx apps/web/test/Onboarding.test.tsx
git commit -m "feat(web): 激活对话框加起名输入 + 实时邮箱预览 + 按钮门控"
```

---

## Task 10: Provisioning 视图展示名字 + 邮箱 + 生成邮箱步骤

**Files:**
- Modify: `apps/web/src/onboarding/Onboarding.tsx:87-95`

- [ ] **Step 1: 改 provisioning 视图**

替换第 87-95 行 `view.mode === 'provisioning'` 块：

```tsx
        {view.mode === 'provisioning' && (
          <div className="fade">
            {name.trim() && (
              <div style={{ margin: '4px 0 14px' }}>
                <div style={{ fontSize: 15, fontWeight: 650 }}>{name.trim()}</div>
                <div className="dim" style={{ fontSize: 11.5, fontFamily: 'monospace' }}>{assistantEmailPreview(name, domain)}</div>
              </div>
            )}
            <div className="muted" style={{ height: 20, margin: '12px 0', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontSize: 13 }}>
              <span className="spin"><IconRefresh size={13} /></span>{view.step}
            </div>
            <div className="progress"><div style={{ width: `${view.pct}%` }} /></div>
            {name.trim() && (
              <div className="dim" style={{ fontSize: 11.5, marginTop: 10 }}>
                ✉️ 为助理生成专属邮箱：{assistantEmailPreview(name, domain)}
              </div>
            )}
          </div>
        )}
```

- [ ] **Step 2: 冒烟（手动）**

Run: `pnpm dev`，走激活流程：输入名字→看预览→激活→进度页顶部显示名+邮箱+生成邮箱行→进桌面。
Expected: 一致。

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/onboarding/Onboarding.tsx
git commit -m "feat(web): provisioning 进度页展示助理名+邮箱"
```

---

## Task 11: 助理名全局替换（读 `useAssistantName`）

**Files:**
- Modify: `apps/web/src/desktop/Desktop.tsx`、`Dock.tsx`、`Menubar.tsx`、`apps/chat/Conversation.tsx`、`apps/chat/Composer.tsx`

**原则：** 指代"这个助理"的用户可见名 → `useAssistantName()`；产品品牌"灵犀"（onboarding 标题"欢迎使用灵犀"）→ 保留。

> ⚠️ 既有组件测试可能被打破：`test/Dock.test.tsx`（改 Dock）、`test/Conversation.test.tsx`（改思考文案）。Step 6 前跑 `pnpm --filter @lingxi/web test Dock Conversation`，红了就把写死的"灵犀助理/灵犀正在思考"断言改成助理名（测试默认 `assistantAtom.name` 为 null → 回退"灵犀"，多数断言可能仍过；以实际为准）。

- [ ] **Step 1: Desktop chat 窗口标题动态化**

`Desktop.tsx`：import `import { useAssistantName } from '../states/assistant.atom.js';`；组件内 `const assistantName = useAssistantName();`；渲染窗口（103-105 行）：

```tsx
        {openApps.map((id, i) => {
          const meta = titles[id];
          const title = id === 'chat' ? assistantName : meta.title;
          return (
            <Window key={id} title={title} icon={meta.icon} width={meta.w} height={meta.h} offsetX={i * 20} offsetY={i * 20} zIndex={zMap[id] ?? (i + 1)} onClose={() => closeApp(id)} onFocus={() => focusApp(id)}>
              {renderApp(id, openApp)}
            </Window>
          );
        })}
```

- [ ] **Step 2: Dock chat 标签动态化**

`Dock.tsx`：import `useAssistantName`；组件内 `const assistantName = useAssistantName();`，map 渲染时 `const label = app.id === 'chat' ? assistantName : app.name;`，tooltip/文字用 `label`。

- [ ] **Step 3: Menubar 名字动态化**

`Menubar.tsx` 第 34 行 `<span>灵犀</span>` → `<span>{useAssistantName()}</span>`（import hook）。

- [ ] **Step 4: Conversation 思考文案动态化**

`Conversation.tsx`：组件内 `const n = useAssistantName();`，把 `THINKING_TEXTS`（18-24 行）里写死的 `'灵犀正在思考…'` 在使用点改为 `` `${n}正在思考…` ``。

- [ ] **Step 5: Composer placeholder 动态化**

`Composer.tsx` 第 36 行 → 组件内 `const n = useAssistantName();`，`placeholder={\`继续和${n}对话…\`}`。

- [ ] **Step 6: 冒烟（手动） + Commit**

Run: `pnpm dev`，起名"Aria"的账号进桌面，确认 chat 标题/Dock/Menubar/输入框/思考文案都是"Aria"；onboarding"欢迎使用灵犀"仍是品牌名。

```bash
git add apps/web/src/desktop/Desktop.tsx apps/web/src/desktop/Dock.tsx apps/web/src/desktop/Menubar.tsx apps/web/src/apps/chat/Conversation.tsx apps/web/src/apps/chat/Composer.tsx
git commit -m "feat(web): 助理名全局替换为用户起的名字"
```

---

# Phase 2 · 改动一：IM 绑定 Hub

## Task 12: 抽离 `useWechatBind` hook

**Files:**
- Create: `apps/web/src/apps/im/useWechatBind.ts`

把 `WechatApp.tsx` 第 29-119 行状态机原样搬进 hook，错误改回调。

- [ ] **Step 1: 实现**

```ts
// apps/web/src/apps/im/useWechatBind.ts
import { useEffect, useState } from 'react';
import { startWechatBind, pollWechatBind, getMyWechatBind, unbindWechat } from '../../lib/api.js';

export type WechatSub = 'wait' | 'scaned' | 'expired' | 'redirect';
export type WechatBindState =
  | { kind: 'loading' }
  | { kind: 'unbound' }
  | { kind: 'starting' }
  | { kind: 'awaiting_scan'; qrcode: string; qr_content: string; sub: WechatSub }
  | { kind: 'bound'; ilink_bot_id: string; bound_at: string };

export const WECHAT_SUB_HINT: Record<WechatSub, string> = {
  wait: '等待扫码…',
  scaned: '已扫码，请在微信里确认',
  expired: '二维码已过期，请点击刷新',
  redirect: 'iLink 返回 redirect，本地暂不支持，请重试',
};

const POLL_INTERVAL_MS = 3000;

interface Opts { onBound?: () => void; onError?: (msg: string) => void; }

export const useWechatBind = (opts: Opts = {}) => {
  const [state, setState] = useState<WechatBindState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const timeoutId = window.setTimeout(() => { if (!cancelled) setState({ kind: 'unbound' }); }, 5000);
    void (async () => {
      try {
        const info = await getMyWechatBind();
        if (cancelled) return;
        window.clearTimeout(timeoutId);
        setState(info.bound
          ? { kind: 'bound', ilink_bot_id: info.ilink_bot_id, bound_at: info.bound_at }
          : { kind: 'unbound' });
      } catch {
        if (cancelled) return;
        window.clearTimeout(timeoutId);
        setState({ kind: 'unbound' });
      }
    })();
    return () => { cancelled = true; window.clearTimeout(timeoutId); };
  }, []);

  const pollKey = state.kind === 'awaiting_scan' && (state.sub === 'wait' || state.sub === 'scaned')
    ? state.qrcode : null;

  useEffect(() => {
    if (!pollKey) return;
    let cancelled = false;
    const qrcode = pollKey;
    const tick = async () => {
      if (cancelled) return;
      try {
        const r = await pollWechatBind(qrcode);
        if (cancelled) return;
        if (r.status === 'confirmed') {
          const info = await getMyWechatBind();
          if (cancelled || !info.bound) return;
          setState({ kind: 'bound', ilink_bot_id: info.ilink_bot_id, bound_at: info.bound_at });
          opts.onBound?.();
        } else if (r.status === 'expired') {
          setState((s) => s.kind === 'awaiting_scan' ? { ...s, sub: 'expired' } : s);
        } else if (r.status === 'scaned_but_redirect') {
          setState((s) => s.kind === 'awaiting_scan' ? { ...s, sub: 'redirect' } : s);
        } else {
          setState((s) => s.kind === 'awaiting_scan' ? { ...s, sub: r.status } : s);
        }
      } catch { /* 下一拍重试 */ }
    };
    const interval = setInterval(tick, POLL_INTERVAL_MS);
    void tick();
    return () => { cancelled = true; clearInterval(interval); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollKey]);

  const start = async () => {
    setState({ kind: 'starting' });
    try {
      const { qrcode, qr_content } = await startWechatBind();
      setState({ kind: 'awaiting_scan', qrcode, qr_content, sub: 'wait' });
    } catch {
      setState({ kind: 'unbound' });
      opts.onError?.('启动绑定失败，请稍后再试');
    }
  };

  const unbind = async () => {
    try { await unbindWechat(); setState({ kind: 'unbound' }); }
    catch { opts.onError?.('解绑失败'); }
  };

  return { state, start, unbind };
};
```

- [ ] **Step 2: 编译 + Commit**

Run: `pnpm --filter @lingxi/web build`（无错）

```bash
git add apps/web/src/apps/im/useWechatBind.ts
git commit -m "refactor(web): 抽离 useWechatBind 状态机"
```

---

## Task 13: `IMProviderCard` 组件

**Files:**
- Create: `apps/web/src/apps/im/IMProviderCard.tsx`
- Create: `apps/web/test/IMProviderCard.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
// apps/web/test/IMProviderCard.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IMProviderCard } from '../src/apps/im/IMProviderCard.js';
import { IM_PROVIDERS } from '../src/apps/im/providers.js';

const wechat = IM_PROVIDERS.find((p) => p.id === 'wechat')!;
const feishu = IM_PROVIDERS.find((p) => p.id === 'feishu')!;
const noop = vi.fn();

describe('IMProviderCard', () => {
  it('未绑定：显示"绑定"，无"已生效"', () => {
    render(<IMProviderCard provider={wechat} bound={false} onBind={noop} onUnbind={noop} />);
    expect(screen.getByRole('button', { name: '绑定' })).toBeInTheDocument();
    expect(screen.queryByText('已生效')).not.toBeInTheDocument();
  });
  it('已绑定：显示"已生效" + "解绑"', () => {
    render(<IMProviderCard provider={wechat} bound boundAt={new Date().toISOString()} onBind={noop} onUnbind={noop} />);
    expect(screen.getByText('已生效')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '解绑' })).toBeInTheDocument();
  });
  it('即将上线：灰徽章 + 无按钮', () => {
    render(<IMProviderCard provider={feishu} bound={false} onBind={noop} onUnbind={noop} />);
    expect(screen.getByText('即将上线')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @lingxi/web test IMProviderCard`（FAIL）

- [ ] **Step 3: 实现**

```tsx
// apps/web/src/apps/im/IMProviderCard.tsx
import type { IMProvider } from './providers.js';

interface Props {
  provider: IMProvider;
  bound: boolean;
  boundAt?: string;
  boundNick?: string;
  onBind: () => void;
  onUnbind: () => void;
}

export const IMProviderCard = ({ provider, bound, boundAt, boundNick, onBind, onUnbind }: Props) => {
  const comingSoon = provider.status === 'coming_soon';
  const boundDate = boundAt ? new Date(boundAt).toLocaleDateString('zh-CN') : '';
  const desc = bound ? `绑定于 ${boundDate}${boundNick ? ` · ${boundNick}` : ''}` : provider.unboundDesc;
  return (
    <div className="card" style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 14, opacity: comingSoon ? 0.6 : 1 }}>
      <span style={{ width: 44, height: 44, borderRadius: 12, background: provider.brandWeak, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {provider.icon}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 650, fontSize: 15 }}>{provider.name}</span>
          {bound && <span style={{ fontSize: 11, color: 'var(--ok)', background: 'rgba(22,163,74,0.12)', padding: '1px 8px', borderRadius: 999 }}>已生效</span>}
          {comingSoon && <span style={{ fontSize: 11, color: 'var(--muted)', background: 'rgba(0,0,0,0.06)', padding: '1px 8px', borderRadius: 999 }}>即将上线</span>}
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{desc}</div>
      </div>
      {!comingSoon && (bound
        ? <button className="btn btn-ghost" style={{ color: 'var(--bad)' }} onClick={onUnbind}>解绑</button>
        : <button className="btn btn-primary" style={{ background: provider.brand }} onClick={onBind}>绑定</button>
      )}
    </div>
  );
};
```

- [ ] **Step 4: 跑测试确认通过 + Commit**

Run: `pnpm --filter @lingxi/web test IMProviderCard`（PASS）

```bash
git add apps/web/src/apps/im/IMProviderCard.tsx apps/web/test/IMProviderCard.test.tsx
git commit -m "feat(web): IMProviderCard 三状态卡片"
```

---

## Task 14: `IMBindDialog` 绑定弹窗（微信复用 hook）

**Files:**
- Create: `apps/web/src/apps/im/IMBindDialog.tsx`

- [ ] **Step 1: 实现**

```tsx
// apps/web/src/apps/im/IMBindDialog.tsx
import type { ReactNode } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { IconRefresh } from '../../lib/icons.js';
import type { IMProvider } from './providers.js';
import { useWechatBind, WECHAT_SUB_HINT } from './useWechatBind.js';
import { useToast } from '../../states/toast.atom.js';

interface Props {
  provider: IMProvider;
  assistantName: string;
  onClose: () => void;
  onBound: () => void;   // Hub: 刷新计数
}

export const IMBindDialog = ({ provider, assistantName, onClose, onBound }: Props) => {
  const toast = useToast();
  const { state, start, unbind } = useWechatBind({
    onBound: () => { toast(`${provider.name}绑定成功`); onBound(); },
    onError: (m) => toast(m, 'error'),
  });

  if (provider.id !== 'wechat') {
    return <Backdrop onClose={onClose}><div style={{ padding: 28, background: '#fff', borderRadius: 14 }}>{provider.name}绑定即将上线</div></Backdrop>;
  }

  const handleUnbind = async () => { await unbind(); toast(`${provider.name}已解绑`); onBound(); onClose(); };

  return (
    <Backdrop onClose={onClose}>
      <div style={{ width: 480, background: '#fff', borderRadius: 14, overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ background: provider.brandWeak, padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ display: 'inline-flex' }}>{provider.icon}</span>
          <span style={{ fontWeight: 650 }}>{provider.bindTitlePrefix} {assistantName}</span>
        </div>
        <div style={{ padding: 22 }}>
          {state.kind === 'loading' && <div className="dim">加载中…</div>}
          {state.kind === 'unbound' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'flex-start' }}>
              <Steps steps={provider.steps} />
              <button className="btn btn-primary" style={{ background: provider.brand }} onClick={start}>获取二维码</button>
            </div>
          )}
          {state.kind === 'starting' && <div className="dim">正在请求二维码…</div>}
          {state.kind === 'awaiting_scan' && (
            <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'center' }}>
              <div style={{ width: 200, height: 200, background: '#fff', border: '1px solid var(--border)', borderRadius: 14, padding: 10, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {state.qr_content ? <QRCodeSVG value={state.qr_content} size={180} level="M" /> : <div className="dim">无 QR</div>}
                {(state.sub === 'expired' || state.sub === 'redirect') && (
                  <div style={{ position: 'absolute', inset: 0, background: 'rgba(255,255,255,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: 'var(--bad)', fontWeight: 600, borderRadius: 14 }}>
                    {state.sub === 'expired' ? '二维码已过期' : '需重试'}
                  </div>
                )}
              </div>
              <div style={{ flex: 1, minWidth: 200 }}>
                <Steps steps={provider.steps} />
                <div className="muted" style={{ fontSize: 13, margin: '10px 0' }}>{WECHAT_SUB_HINT[state.sub]}</div>
                <button className="btn btn-ghost" onClick={start}><IconRefresh size={15} />刷新二维码</button>
              </div>
            </div>
          )}
          {state.kind === 'bound' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ fontWeight: 650 }}>✓ 已绑定{provider.name} · bot …{state.ilink_bot_id.slice(-4)}</div>
              <div className="muted" style={{ fontSize: 13, lineHeight: 1.8 }}>助理正在替你监听{provider.name}。联系人不会知道是 AI 回复。</div>
              <button className="btn btn-ghost" style={{ alignSelf: 'flex-start', color: 'var(--bad)' }} onClick={handleUnbind}>解绑</button>
            </div>
          )}
        </div>
      </div>
    </Backdrop>
  );
};

const Steps = ({ steps }: { steps: readonly string[] }) => (
  <div className="muted" style={{ fontSize: 13, lineHeight: 1.9 }}>
    {steps.map((s, i) => <div key={i}>{i + 1} · {s}</div>)}
  </div>
);

const Backdrop = ({ children, onClose }: { children: ReactNode; onClose: () => void }) => (
  <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.32)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
    {children}
  </div>
);
```

- [ ] **Step 2: 编译 + Commit**

Run: `pnpm --filter @lingxi/web build`（无错）

```bash
git add apps/web/src/apps/im/IMBindDialog.tsx
git commit -m "feat(web): IMBindDialog 主题化绑定弹窗(微信复用 hook)"
```

---

## Task 15: `IMHub` + 接入 Desktop 窗口

**Files:**
- Create: `apps/web/src/apps/im/IMHub.tsx`
- Modify: `apps/web/src/desktop/Desktop.tsx`

- [ ] **Step 1: 实现 IMHub**

```tsx
// apps/web/src/apps/im/IMHub.tsx
import { useState } from 'react';
import { IM_PROVIDERS, type IMProvider } from './providers.js';
import { IMProviderCard } from './IMProviderCard.js';
import { IMBindDialog } from './IMBindDialog.js';
import { imBindingsAtom, useIMCount } from '../../states/imBindings.atom.js';
import { useAssistantName } from '../../states/assistant.atom.js';

export const IMHub = () => {
  const [bindings, actions] = imBindingsAtom.use();
  const n = useIMCount();
  const assistantName = useAssistantName();
  const [active, setActive] = useState<IMProvider | null>(null);

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 22 }}>
      {n === 0 && (
        <div className="muted" style={{ fontSize: 13, marginBottom: 16, padding: 12, background: 'var(--accent-weak2)', borderRadius: 10 }}>
          绑定 IM 后，可在 IM 里直接给助理派活。先绑一个试试 👇
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {IM_PROVIDERS.map((p) => (
          <IMProviderCard key={p.id} provider={p} bound={!!bindings[p.id]}
            onBind={() => setActive(p)} onUnbind={() => setActive(p)} />
        ))}
      </div>
      {active && (
        <IMBindDialog provider={active} assistantName={assistantName}
          onClose={() => setActive(null)} onBound={() => { void actions.refresh(); }} />
      )}
    </div>
  );
};
```

- [ ] **Step 2: Desktop 窗口 `wechat` → `im`**

`Desktop.tsx`：
- 第 12 行 import 改 `import { IMHub } from '../apps/im/IMHub.js';`
- 第 17 行 `type AppId = DockAppId | 'wechat';` → `| 'im';`
- `renderApp`：`manage` 行 `<ManageApp onOpenIM={() => openApp('im')} />`；`if (id === 'wechat')` → `if (id === 'im') return <IMHub />;`
- `titles` 把 `wechat:` 行换成：`im: { title: 'IM 绑定', icon: <IconMessage size={14} />, w: 600, h: 480 },`

- [ ] **Step 3: 编译确认（ManageApp prop 由 Task 16 落定）**

Run: `pnpm --filter @lingxi/web build`
Expected: 可能报 ManageApp `onOpenIM` 未定义——Task 16 修；本步确保 IMHub/Desktop 自身无语法错。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/apps/im/IMHub.tsx apps/web/src/desktop/Desktop.tsx
git commit -m "feat(web): IMHub + Desktop 窗口 wechat→im"
```

---

## Task 16: ManageApp 身份总览卡（名+真实邮箱+N IM）+ "IM 绑定 · N"

**Files:**
- Modify: `apps/web/src/apps/manage/ManageApp.tsx`
- Modify: `apps/web/test/ManageApp.test.tsx`（baseline 红，重写）

- [ ] **Step 1: 改 ManageApp 头部 + prop**

`ManageApp.tsx`：
- import：删 `getMyWechatBind`；加：

```ts
import { useAssistantName, assistantAtom } from '../../states/assistant.atom.js';
import { assistantEmailPreview } from '../../lib/assistantEmail.js';
import { authAtom } from '../../states/auth.atom.js';
import { useIMCount } from '../../states/imBindings.atom.js';
```

- 组件签名（66 行）：`export const ManageApp = ({ onOpenIM }: { onOpenIM: () => void }) => {`
- 删第 72-81 行 `wechatBound` useState + effect。
- 组件内加：

```ts
  const assistantName = useAssistantName();
  const [assistant] = assistantAtom.use();
  const [auth] = authAtom.use();
  const domain = auth.status === 'authenticated' ? auth.user.email_domain : 'mail.localhost';
  // 优先真实邮箱(含后缀)；未拿到时退回本地预览(无后缀)
  const email = assistant.email ?? assistantEmailPreview(assistantName, domain);
  const imCount = useIMCount();
```

- 头部卡（88-108 行）替换：

```tsx
        <div className="card" style={{ padding: 18, display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
          <span style={{ display: 'inline-flex', width: 52, height: 52, borderRadius: 14, background: '#7c3aed1f', color: '#7c3aed', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <IconSpark size={26} strokeWidth={1.9} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 650, fontSize: 16 }}>{assistantName}</div>
            <div className="dim" style={{ fontSize: 12, fontFamily: 'monospace', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{email}</div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
              <span className="pulse" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--ok)', display: 'inline-block', marginRight: 6 }} />
              在线 · 专业版 · {imCount > 0 ? `已接入 ${imCount} 个 IM` : '未接入 IM'}
            </div>
          </div>
          <button className="btn btn-primary" onClick={onOpenIM} title="管理 IM 接入">
            <IconMessage size={15} />
            IM 绑定{imCount > 0 ? ` · ${imCount}` : ''}
          </button>
        </div>
```

- [ ] **Step 2: 重写 ManageApp 测试**

整体替换 `apps/web/test/ManageApp.test.tsx`：

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WithStore } from '../src/atom/index.js';
import * as api from '../src/lib/api.js';
import { ManageApp } from '../src/apps/manage/ManageApp.js';

vi.mock('../src/lib/api.js', async (orig) => ({
  ...(await orig<typeof api>()),
  me: vi.fn().mockResolvedValue({ user_id: 'u1', provider: 'dev', external_id: 'x', email: null, nickname: '阿强', avatar_url: null, email_domain: 'mail.laifu.uncagedai.org' }),
  status: vi.fn().mockResolvedValue({ status: 'ready', provisioning_step: null, progress_pct: 100, error_message: null, entitlements_desired: [], entitlements_observed: [], container_token_version: 0, assistant_name: 'Aria', assistant_email: 'aria@mail.laifu.uncagedai.org' }),
  getMyWechatBind: vi.fn().mockResolvedValue({ bound: false }),
}));

describe('ManageApp 身份卡', () => {
  it('显示助理名 + 真实邮箱 + 未接入 IM + IM 绑定按钮', async () => {
    render(<WithStore><ManageApp onOpenIM={() => {}} /></WithStore>);
    expect(await screen.findByText('Aria')).toBeInTheDocument();
    expect(screen.getByText('aria@mail.laifu.uncagedai.org')).toBeInTheDocument();
    expect(screen.getByText(/未接入 IM/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /IM 绑定/ })).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: 跑测试确认通过 + Commit**

Run: `pnpm --filter @lingxi/web test ManageApp`（PASS，baseline 红被修）

```bash
git add apps/web/src/apps/manage/ManageApp.tsx apps/web/test/ManageApp.test.tsx
git commit -m "feat(web): ManageApp 身份总览卡(名+真实邮箱+N IM) + IM 绑定按钮"
```

---

## Task 17: 挂载 ToastHost + 清理旧 WechatApp + 全量验证

**Files:**
- Modify: `apps/web/src/desktop/Desktop.tsx`
- Delete: `apps/web/src/apps/wechat/WechatApp.tsx`

- [ ] **Step 1: 挂 ToastHost**

`Desktop.tsx`：import `import { ToastHost } from './ToastHost.js';`；在 `!ready` 分支（84-94 行）和主返回（97-113 行）两个根 `<div>` 内各加 `<ToastHost />`（`<Wallpaper />` 之后）。

- [ ] **Step 2: 删旧 WechatApp（确认无引用）**

Run: `grep -rn "WechatApp\|apps/wechat" apps/web/src`
Expected: 仅剩自身。无其它引用则 `git rm apps/web/src/apps/wechat/WechatApp.tsx`，否则先消引用。

- [ ] **Step 3: 全量 test + build 门**

Run: `pnpm --filter @lingxi/shared build && pnpm --filter @lingxi/gateway test && pnpm --filter @lingxi/web test && pnpm --filter @lingxi/web build`
Expected:
- shared build / gateway test 绿
- web test：除已知 baseline 红 `test/CapabilityAction.test.tsx`（范围外）外全绿；新增测试全绿
- web build 绿

- [ ] **Step 4: 端到端冒烟（pnpm dev）**

> 前置：本地 dev DB 需先加列 `cd packages/db && pnpm db:push`（见风险 1）；dev `EMAIL_DOMAIN=mail.localhost`，预览/真实都用它。

Run: `pnpm dev`，新账号走完整链路：
1. 激活：起名"灵犀"→邮箱预览 `lingxi@mail.localhost`→空名 disabled→填名 enable→激活→进度页显示名+邮箱→进桌面
2. 全局名：chat 标题 / Dock / Menubar / 输入框 / 思考文案 = "灵犀"
3. 装备页头部身份卡：名 + **真实邮箱**（来自 status，如 `lingxi@mail.localhost`，若与别人撞则带后缀）+ 未接入 IM + "IM 绑定"按钮
4. 点 "IM 绑定" → IM Hub 窗口 → 微信卡（绿可绑）+ 飞书卡（灰即将上线无按钮）+ 空状态引导
5. 点微信"绑定" → 主题色弹窗 + 标题"用微信扫一扫绑定 灵犀" + 二维码 + 三步 + 刷新
6. （有真实 iLink 环境则扫码成功 → toast"微信绑定成功" → 头部"已接入 1 个 IM" + "IM 绑定 · 1"）
7. 验证真实邮箱：起第二个账号也叫"灵犀"，确认其身份卡邮箱带后缀（如 `lingxi-2@...`），证明碰撞去重生效
Expected: 全部一致，无 console 异常。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/desktop/Desktop.tsx
git rm apps/web/src/apps/wechat/WechatApp.tsx
git commit -m "feat(web): 挂载 ToastHost + 移除旧 WechatApp"
```

---

## 实施顺序与依赖

```
Phase 0
  Task 1 (shared 校验+拼音base) → Task 2 (契约+schema) → Task 3 (后端 邮箱/handler)   [后端链路串行]
  Task 4 (前端预览) · Task 5 (assistantAtom) · Task 6 (toast) · Task 7 (注册表+图标) · Task 8 (imBindings)
       [前端基础，Task 4/5 依赖 Task 1/2 的 shared 构建产物，其余独立]
Phase 1：Task 9 (起名输入) → Task 10 (进度页) → Task 11 (全局替换)
Phase 2：Task 12 → 13 → 14 → 15 → 16 → 17
```

跨切提醒：Task 5/9 用 `api.purchase` 新签名；Task 15/16 的 `onOpenWechat`→`onOpenIM` 一起编译过（Task 15 Step 3 可暂留旧名，Task 16 落定）。

---

## Self-Review（spec 覆盖核对）

**改动一 IM 绑定：** 入口改名/打开 Hub(Task 15/16) · 固定信息位卡片(Task 13) · 三状态徽章(Task 13) · 主题色弹窗+三步+名字标题(Task 14) · 就地解绑(Task 13/14) · 空状态(Task 15) · 飞书即将上线灰卡(Task 7/13) · 绑定成功 toast+N+1(Task 14→imBindings→useIMCount) · **加新 IM = 加 config，不加表**(Task 7/8 架构)。

**改动二 起名 + 邮箱：** 必填起名/中英文/全局贯穿(Task 9/11) · 红星+必填+placeholder+autoFocus(Task 9) · **真实**邮箱实时预览(拼音 base 复用 shared，域名 env 下发)(Task 1/4/9) · 名字非空门控+纯空白 disabled+24 字符(Task 1/9) · 进度页名+邮箱+生成邮箱行(Task 10) · 名字出现位置全覆盖(Task 11/16/14) · 名字持久化(Task 2/3/5) · **真实邮箱按名字生成 + 碰撞后缀去重**(Task 3) · 域名 prod/test 按 env 切(Task 2/3 `EMAIL_DOMAIN`)。

**本期不做：** 改名、邮箱占用前端提示、真实飞书绑定、IM 多账号、给助理头像。welcome thread 自我介绍若为后端 seed 属后续；前端可见名 Task 11 已覆盖。

**类型一致性：** `assistant_name`/`assistant_email`(snake，契约) ↔ `assistantAtom.{name,email}`(前端)；`assistantLocalpartBase`(shared) 前端 Task 4 / 后端 Task 3 同源消费；`email_domain`(AuthMeResponse) → authAtom → Task 9/16 预览；`IMProviderId`/`IM_PROVIDERS`/`imBindingsAtom`/`useIMCount` 贯穿 7/8/15/16；`useWechatBind` 返回 `{state,start,unbind}` 定义(12)消费(14)一致；`onOpenIM` 两侧(15/16)一致。

---

## 已知风险 / 提醒

1. **dev DB 同步**：Task 2 生成迁移后，本地 dev 跑 `cd packages/db && pnpm db:push` 加 `assistant_name` 列，否则 purchase 写入报列不存在。云上 dev/prod 走 `db:generate`+`db:migrate`。
2. **邮箱 local part 是路由主键**：Task 3 改生成规则只影响**新分配**地址；存量 `u-<hash>` 行经 `getAddress` 幂等返回、不变。务必保证 candidate 唯一性（最后带 userId hash 兜底）+ insert 冲突即试下一个，避免把别人地址抢了。
3. **pinyin-pro 落在 shared**：前后端共用。gateway 经 `@lingxi/shared` 间接依赖；若 `build-deploy.sh` 扁平化后 gateway 运行时解析不到 pinyin-pro，则同时 `pnpm --filter @lingxi/gateway add pinyin-pro` 兜底（dev 用 tsx 一般能从 workspace 解析）。
4. **test 环境邮件域**：部署 test 时 bicep 传 `emailDomain=test-mail.laifu.uncagedai.org`（参数已支持，非代码改动）。dev 仍 `mail.localhost`。
5. **预览 vs 真实可能短暂不一致**：激活那一刻前端预览无后缀（乐观），真实地址若撞名带后缀——身份卡显示的是 status 返回的真实值，会自动纠正（spec 接受"前端不展示 fallback"）。
6. **lint/test 门**：web `lint` baseline 红不算门；`test` 除 `CapabilityAction.test.tsx`(范围外)外应全绿。
7. **邮箱与"邮件能力"解耦**：本计划在**购买时**就分配邮箱地址（身份），与用户是否"装备邮件能力"(`email` entitlement，控制 agent 实际收发)无关。既有 onEnable hook 调 `ensureEmailAddress(userId)` 仍幂等可用（会拿到购买时已分配的地址）。若产品上要求"未装备邮件能力则不暴露地址"，在身份卡按 entitlements 判断是否显示邮箱——本计划默认始终显示（身份）。
```