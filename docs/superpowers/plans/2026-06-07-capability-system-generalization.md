# 能力系统通用化(子项 A)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把云盘特例化的能力管理重构成数据驱动的通用能力系统(目录 + 装备/市场两 tab + 通用装备/移除),为后续邮件能力(子项 B)铺底。

**Architecture:** 新增一个前端能力目录(catalog)作单一数据源,驱动 ManageApp(装备/市场)、Dock(桌面 app)、Desktop(装备即开窗);把 `BuyCloudButton`/`DisableCloudButton` 抽成参数化的 `CapabilityEquip`/`CapabilityRemove`;后端 entitlements 路由从 `cloud` 写死改成 `:feature` + 白名单。后端 DAO 已参数化,不动。

**Tech Stack:** React 18 + TypeScript(Vite),vitest + @testing-library/react;gateway Express + vitest + supertest。

**对应 spec:** `docs/superpowers/specs/2026-06-07-capability-system-generalization-design.md`

---

## 文件结构

**新建:**
- `apps/web/src/lib/capabilities.tsx` — 能力目录(单一数据源):`Capability` 类型 + `CAPABILITIES` 数组 + 派生导出(`MARKET_CAPABILITIES` / `getCapability` / `isEquipped`)。
- `apps/web/src/apps/manage/CapabilityAction.tsx` — 通用 `CapabilityEquip`(市场装备)+ `CapabilityRemove`(✕ 退订),内含共用 `Modal`。
- `apps/web/test/capabilities.test.tsx` — 目录派生函数测试。
- `apps/web/test/CapabilityAction.test.tsx` — 通用装备/移除组件测试(由旧 Buy/DisableCloud 测试移植,参数化到 cloud)。

**修改:**
- `apps/gateway/src/api/entitlements.ts` — 路由 `:feature` + 白名单 `ALLOWED_FEATURES`。
- `apps/gateway/test/api/entitlements.test.ts` — 适配参数化路由 + 加未知 feature → 404。
- `apps/web/src/lib/api.ts` — `enableCloud`/`disableCloud` → 通用 `enableFeature`/`disableFeature`。
- `apps/web/src/desktop/Dock.tsx` — 条件 app 改由 catalog 的 `desktopApp` 驱动。
- `apps/web/src/desktop/Desktop.tsx` — "新装备即开窗" 改由 catalog 驱动。
- `apps/web/src/apps/manage/ManageApp.tsx` — 重写为装备/市场两 tab,数据驱动。

**删除:**
- `apps/web/src/apps/manage/BuyCloudButton.tsx` + `apps/web/test/BuyCloudButton.test.tsx`
- `apps/web/src/apps/manage/DisableCloudButton.tsx` + `apps/web/test/DisableCloudButton.test.tsx`

**本期 catalog 只含已实现能力:** 默认基线 `web`/`file`/`wechat`(不可移除、不进市场)+ 可装备的 `cloud`。**邮件 `email` 由子项 B 往 catalog 追加一条 + 后端白名单加 `email`,本计划不含。**

**测试命令约定:**
- 单个 web 测试文件:`pnpm --filter @lingxi/web exec vitest run <相对路径>`
- 全部 web 测试:`pnpm --filter @lingxi/web test`
- web 类型检查:`pnpm --filter @lingxi/web lint`
- 单个 gateway 测试文件:`pnpm --filter @lingxi/gateway exec vitest run <相对路径>`
- gateway 类型检查:`pnpm --filter @lingxi/gateway lint`

---

## Task 1: 后端 entitlements 路由参数化 + 白名单

**Files:**
- Modify: `apps/gateway/src/api/entitlements.ts`
- Test: `apps/gateway/test/api/entitlements.test.ts`

- [ ] **Step 1: 改测试 —— 路由用 :feature,新增未知 feature → 404**

把 `apps/gateway/test/api/entitlements.test.ts` 末尾(`describe('POST /api/entitlements/cloud/disable'...)` 块之后、文件末尾)追加一个新 describe,并保持原有两个 describe 不变(它们打的 `/api/entitlements/cloud/enable|disable` 在参数化后依然命中):

```typescript
describe('feature allowlist', () => {
  it('unknown feature → 404, no DAO call', async () => {
    const enable = vi.fn();
    const app = makeApp({
      enable, disable: vi.fn(), listActive: vi.fn(),
      bumpTokenVersion: vi.fn(), restartContainer: vi.fn(),
      signTokenAndInject: vi.fn(),
    });
    const res = await request(app).post('/api/entitlements/bogus/enable');
    expect(res.status).toBe(404);
    expect(enable).not.toHaveBeenCalled();
  });

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
});
```

- [ ] **Step 2: 跑测试看新用例失败(路由还没参数化,bogus 会 404 但 email 也 404 因为根本没匹配;实际旧 hardcoded 路由下 `/bogus/enable` 不匹配任何 route → Express 默认 404,DAO 未调用 → 可能"假通过")**

Run: `pnpm --filter @lingxi/gateway exec vitest run test/api/entitlements.test.ts`
Expected: 新 describe 可能通过(因 404 是默认),但这不代表实现到位。继续 Step 3 真正参数化,再用 Step 5 的 happy-path 回归保证 `cloud` 仍工作。

> 说明:这一步的测试主要锁"未知 feature 不调 DAO"的契约;真正的行为变化由 Step 3 引入,Step 5 全量回归。

- [ ] **Step 3: 参数化实现 —— 用 `:feature` + 白名单 + DRY 出 handler**

把 `apps/gateway/src/api/entitlements.ts` 整体替换为:

```typescript
import { Router, type Router as RouterType, type Request, type Response, type RequestHandler } from 'express';
import type { EntitlementsDao } from '../db/entitlements-dao.js';
import type { EntitlementChangeResponse } from '@lingxi/shared';

/** 允许通过此端点开关的能力。新增能力时在此追加(与前端 catalog 同步)。 */
const ALLOWED_FEATURES = new Set<string>(['cloud']);   // 子项 B 会追加 'email'

export interface EntitlementsRouterDeps {
  entitlements: EntitlementsDao;
  /** Trigger a container restart for the user (ACA restartRevision or local mock). */
  restartContainer: (userId: string) => Promise<void>;
  /**
   * Sign a new LAIFU_USER_TOKEN using the new token_version, and write it
   * to the container's env / secret store so the next start picks it up.
   */
  signTokenAndInject: (userId: string, tokenVersion: number) => Promise<void>;
  sessionMw: RequestHandler;
}

export const buildEntitlementsRouter = (deps: EntitlementsRouterDeps): RouterType => {
  const router = Router();

  // enable / disable 几乎同形,DRY 成一个 handler 工厂。
  const makeHandler = (kind: 'enable' | 'disable'): RequestHandler => async (req: Request, res: Response) => {
    const feature = req.params['feature'] as string;
    if (!ALLOWED_FEATURES.has(feature)) {
      res.status(404).json({ error: `unknown feature: ${feature}` });
      return;
    }
    const userId = req.session!.user_id;
    try {
      const { changed } = kind === 'enable'
        ? await deps.entitlements.enable(userId, feature)
        : await deps.entitlements.disable(userId, feature);

      // Idempotent: 即使 already-active/inactive 也强制 re-sync 容器,避免 DB 和容器漂移。
      // - changed=true: bump token_version (撤销旧 token) + sign 新 token + restart
      // - changed=false: 不 bump (避免无意撤销并发实例),但仍 sign 当前 token + restart resync
      let tokenVersion: number;
      if (changed) {
        tokenVersion = await deps.entitlements.bumpTokenVersion(userId);
      } else {
        const current = await deps.entitlements.getTokenVersion(userId);
        tokenVersion = current ?? 0;
      }
      await deps.signTokenAndInject(userId, tokenVersion);
      // Fire-and-forget restart 让 API 快速返回;前端轮询 /api/status 知道容器何时回来。
      deps.restartContainer(userId).catch((err) => {
        console.error(`[entitlements] restart failed for ${userId}:`, err);
      });
      const active = await deps.entitlements.listActive(userId);
      const body: EntitlementChangeResponse = { ok: true, entitlements: active, changed };
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: 'internal', message: String(err) });
    }
  };

  router.post('/api/entitlements/:feature/enable', deps.sessionMw, makeHandler('enable'));
  router.post('/api/entitlements/:feature/disable', deps.sessionMw, makeHandler('disable'));

  return router;
};
```

- [ ] **Step 4: 类型检查**

Run: `pnpm --filter @lingxi/gateway lint`
Expected: 无错误。

- [ ] **Step 5: 跑全文件测试(回归 cloud happy path + idempotent + disable + 新白名单用例)**

Run: `pnpm --filter @lingxi/gateway exec vitest run test/api/entitlements.test.ts`
Expected: 全部 PASS(原 `cloud/enable`、`cloud/disable` 三个用例 + 新两个 404 用例)。

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/api/entitlements.ts apps/gateway/test/api/entitlements.test.ts
git commit -m "$(cat <<'EOF'
refactor(gateway): entitlements 路由参数化 :feature + 白名单

cloud 写死改 :feature, 白名单 ALLOWED_FEATURES={cloud}(子项B加email)。enable/disable DRY 成 handler 工厂。未知 feature → 404 不调 DAO。底层 DAO 已参数化, 行为不变。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: web api.ts 通用 enableFeature/disableFeature

**Files:**
- Modify: `apps/web/src/lib/api.ts:96-102`

- [ ] **Step 1: 确认旧函数无其它引用(只有待删的两个按钮用)**

Run: `grep -rn "enableCloud\|disableCloud" apps/web/src`
Expected: 仅出现在 `apps/web/src/apps/manage/BuyCloudButton.tsx`(enableCloud)与 `DisableCloudButton.tsx`(disableCloud)——这两个文件 Task 7 删除。若出现别处,需在对应任务一并改。

- [ ] **Step 2: 替换实现**

把 `apps/web/src/lib/api.ts` 中:

```typescript
export const enableCloud = (): Promise<EntitlementChangeResponse> =>
  json('/api/entitlements/cloud/enable', { method: 'POST' });

export const disableCloud = (): Promise<EntitlementChangeResponse> =>
  json('/api/entitlements/cloud/disable', { method: 'POST' });
```

替换为:

```typescript
export const enableFeature = (feature: string): Promise<EntitlementChangeResponse> =>
  json(`/api/entitlements/${encodeURIComponent(feature)}/enable`, { method: 'POST' });

export const disableFeature = (feature: string): Promise<EntitlementChangeResponse> =>
  json(`/api/entitlements/${encodeURIComponent(feature)}/disable`, { method: 'POST' });
```

(其余 cloudList / cloudDownloadUrl / cloudUpload 保持不变。)

- [ ] **Step 3: 类型检查(此时 Buy/DisableCloudButton 仍引用旧名,预期报错——可接受,Task 4/7 修复)**

Run: `pnpm --filter @lingxi/web lint`
Expected: 仅 `BuyCloudButton.tsx` / `DisableCloudButton.tsx` 报 `enableCloud`/`disableCloud` 未导出。**不要**为此回退;它们将在 Task 7 删除,在 Task 4 由新组件取代。先不 commit,继续 Task 3。

> 说明:本任务不单独 commit,与 Task 3、Task 4 同批推进以保持仓库可编译。若用 subagent 逐任务执行,在 Task 4 结束时一并 commit(见 Task 4 Step 8)。

---

## Task 3: 能力目录 capabilities.tsx

**Files:**
- Create: `apps/web/src/lib/capabilities.tsx`
- Test: `apps/web/test/capabilities.test.tsx`

- [ ] **Step 1: 写失败测试**

创建 `apps/web/test/capabilities.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import {
  CAPABILITIES, MARKET_CAPABILITIES, getCapability, isEquipped,
} from '../src/lib/capabilities.js';

describe('capabilities catalog', () => {
  it('默认基线 web/file/wechat 不可移除、不进市场', () => {
    for (const id of ['web', 'file', 'wechat']) {
      const c = getCapability(id)!;
      expect(c).toBeTruthy();
      expect(c.removable).toBe(false);
      expect(c.inMarket).toBe(false);
    }
  });

  it('cloud 可移除、进市场、桌面 app=files', () => {
    const c = getCapability('cloud')!;
    expect(c.removable).toBe(true);
    expect(c.inMarket).toBe(true);
    expect(c.desktopApp).toBe('files');
  });

  it('MARKET_CAPABILITIES 只含 inMarket 的能力(本期 = cloud)', () => {
    expect(MARKET_CAPABILITIES.map((c) => c.id)).toEqual(['cloud']);
  });

  it('isEquipped: 默认能力恒真;可装备能力看 observed', () => {
    expect(isEquipped(getCapability('web')!, [])).toBe(true);
    expect(isEquipped(getCapability('cloud')!, [])).toBe(false);
    expect(isEquipped(getCapability('cloud')!, ['cloud'])).toBe(true);
  });

  it('getCapability 未知 id → undefined', () => {
    expect(getCapability('nope')).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试看失败**

Run: `pnpm --filter @lingxi/web exec vitest run test/capabilities.test.tsx`
Expected: FAIL(`Cannot find module '../src/lib/capabilities.js'`)。

- [ ] **Step 3: 实现目录**

创建 `apps/web/src/lib/capabilities.tsx`:

```tsx
import type { ReactNode } from 'react';
import { IconGlobe, IconFile, IconMessage, IconFolder } from './icons.js';

/** 确认/退订弹窗文案。`lines` 是弹窗里逐行的小字(价格/容量/影响说明)。 */
export interface CapabilityCopy {
  title: string;
  desc: string;
  lines?: string[];
}

export interface Capability {
  /** entitlement key, 与后端 ALLOWED_FEATURES 一致 */
  id: string;
  name: string;
  icon: ReactNode;
  /** 市场卡片 / 已装备卡片副文案 */
  blurb: string;
  /** 仅展示, 0=免费, 不影响逻辑 */
  price: number;
  /** 默认基线能力 = false(不出现 ✕、不进市场) */
  removable: boolean;
  /** 是否在"市场" tab 列出 */
  inMarket: boolean;
  /** 装备后桌面/Dock 出现的 app id;无则不进桌面 */
  desktopApp?: string;
  /** removable/inMarket 能力必填 */
  enableCopy?: CapabilityCopy;
  disableCopy?: CapabilityCopy;
}

const accentIcon = (node: (p: { size?: number; color?: string }) => ReactNode): ReactNode =>
  node({ size: 22, color: 'var(--accent)' });

export const CAPABILITIES: Capability[] = [
  {
    id: 'web', name: '联网搜索', icon: <IconGlobe size={22} color="var(--accent)" />,
    blurb: '让助理联网搜索信息', price: 0, removable: false, inMarket: false,
  },
  {
    id: 'file', name: '文件读写', icon: <IconFile size={22} color="var(--accent)" />,
    blurb: '让助理读写工作区文件', price: 0, removable: false, inMarket: false,
  },
  {
    id: 'wechat', name: '微信收发', icon: <IconMessage size={22} color="var(--accent)" />,
    blurb: '让助理通过微信收发消息', price: 0, removable: false, inMarket: false,
  },
  {
    id: 'cloud', name: '云盘', icon: <IconFolder size={22} color="var(--accent)" />,
    blurb: '让助理把成果保存到云端，桌面会出现"文件"应用',
    price: 0, removable: true, inMarket: true, desktopApp: 'files',
    enableCopy: {
      title: '云盘',
      desc: '让助理把成果保存到云端，桌面会出现"文件"应用',
      lines: ['价格: 免费（后续可能收费）', '容量: 无限制'],
    },
    disableCopy: {
      title: '退订云盘',
      desc: '退订后：',
      lines: ['• 桌面"文件"应用会消失', '• 已发布的文件保留（不删除），重新装备后可继续访问'],
    },
  },
];

export const MARKET_CAPABILITIES: Capability[] = CAPABILITIES.filter((c) => c.inMarket);

export const getCapability = (id: string): Capability | undefined =>
  CAPABILITIES.find((c) => c.id === id);

/** 默认能力恒为已装备;可装备能力看 observed 是否包含。 */
export const isEquipped = (cap: Capability, observed: string[]): boolean =>
  !cap.removable || observed.includes(cap.id);
```

> 注:`accentIcon` helper 暂未使用,删掉以免 lint 报未使用。(若你保留 inline `<IconGlobe ... />` 写法则无需该 helper。)**实现时不要把 `accentIcon` 写进文件** —— 上面图标已用 inline 形式,helper 是多余的,删除该常量。

- [ ] **Step 4: 跑测试看通过**

Run: `pnpm --filter @lingxi/web exec vitest run test/capabilities.test.tsx`
Expected: PASS(5 个用例)。

- [ ] **Step 5: (不单独 commit,见 Task 4 Step 8)**

---

## Task 4: 通用装备/移除组件 CapabilityAction.tsx

**Files:**
- Create: `apps/web/src/apps/manage/CapabilityAction.tsx`
- Test: `apps/web/test/CapabilityAction.test.tsx`

- [ ] **Step 1: 写失败测试(从旧 BuyCloud/DisableCloud 测试移植,参数化到 cloud)**

创建 `apps/web/test/CapabilityAction.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { CapabilityEquip, CapabilityRemove } from '../src/apps/manage/CapabilityAction.js';
import { EntitlementsProvider } from '../src/lib/entitlements-context.js';
import { getCapability } from '../src/lib/capabilities.js';

vi.mock('../src/lib/api.js', () => ({
  enableFeature: vi.fn(),
  disableFeature: vi.fn(),
  status: vi.fn(),
  AuthError: class extends Error {},
}));
import * as api from '../src/lib/api.js';

const CLOUD = getCapability('cloud')!;

function setObserved(observed: string[]) {
  vi.mocked(api.status).mockResolvedValue({
    status: 'ready', provisioning_step: null, progress_pct: 100, error_message: null,
    entitlements_desired: observed, entitlements_observed: observed, container_token_version: 1,
  });
}

describe('CapabilityEquip', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setObserved([]);
    vi.mocked(api.enableFeature).mockReset();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('未装备时显示"购买并装备"', async () => {
    render(<EntitlementsProvider><CapabilityEquip cap={CLOUD} /></EntitlementsProvider>);
    await waitFor(() => expect(screen.getByText(/购买并装备/)).toBeInTheDocument());
  });

  it('observed 含 cloud 时显示"已装备"', async () => {
    setObserved(['cloud']);
    render(<EntitlementsProvider><CapabilityEquip cap={CLOUD} /></EntitlementsProvider>);
    await waitFor(() => expect(screen.getByText(/已装备/)).toBeInTheDocument());
  });

  it('确认框点取消 → 回 idle,不调 API', async () => {
    render(<EntitlementsProvider><CapabilityEquip cap={CLOUD} /></EntitlementsProvider>);
    await waitFor(() => expect(screen.getByText(/购买并装备/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/购买并装备/));
    await waitFor(() => expect(screen.getByText(/确认购买并装备/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/取消/));
    await waitFor(() => expect(screen.queryByText(/价格: 免费/)).not.toBeInTheDocument());
    expect(api.enableFeature).not.toHaveBeenCalled();
  });

  it('确认后调 enableFeature(cloud) 并轮询到 observed 后 onReady', async () => {
    vi.mocked(api.enableFeature).mockResolvedValue({ ok: true, entitlements: ['cloud'], changed: true });
    vi.mocked(api.status)
      .mockResolvedValueOnce({
        status: 'ready', provisioning_step: null, progress_pct: 100, error_message: null,
        entitlements_desired: [], entitlements_observed: [], container_token_version: 0,
      })
      .mockResolvedValue({
        status: 'ready', provisioning_step: null, progress_pct: 100, error_message: null,
        entitlements_desired: ['cloud'], entitlements_observed: ['cloud'], container_token_version: 1,
      });
    const onReady = vi.fn();
    render(<EntitlementsProvider><CapabilityEquip cap={CLOUD} onReady={onReady} /></EntitlementsProvider>);
    await waitFor(() => expect(screen.getByText(/购买并装备/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/购买并装备/));
    await waitFor(() => expect(screen.getByText(/确认购买并装备/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/确认购买并装备/));
    await waitFor(() => expect(screen.getByText(/正在记录订单|正在装备到助理/)).toBeInTheDocument());
    for (let i = 0; i < 5; i++) { await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); }
    await waitFor(() => expect(onReady).toHaveBeenCalled());
    expect(api.enableFeature).toHaveBeenCalledWith('cloud');
  });
});

describe('CapabilityRemove', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setObserved(['cloud']);
    vi.mocked(api.disableFeature).mockReset();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('点 trigger → 确认框;确认后调 disableFeature(cloud)', async () => {
    vi.mocked(api.disableFeature).mockResolvedValue({ ok: true, entitlements: [], changed: true });
    render(
      <EntitlementsProvider>
        <CapabilityRemove cap={CLOUD} trigger={(open) => <button onClick={open}>✕</button>} />
      </EntitlementsProvider>
    );
    fireEvent.click(screen.getByText('✕'));
    await waitFor(() => expect(screen.getByText(/退订云盘/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/确认退订/));
    await waitFor(() => expect(api.disableFeature).toHaveBeenCalledWith('cloud'));
  });
});
```

- [ ] **Step 2: 跑测试看失败**

Run: `pnpm --filter @lingxi/web exec vitest run test/CapabilityAction.test.tsx`
Expected: FAIL(`Cannot find module '../src/apps/manage/CapabilityAction.js'`)。

- [ ] **Step 3: 实现组件**

创建 `apps/web/src/apps/manage/CapabilityAction.tsx`:

```tsx
import { useState, useRef, useEffect } from 'react';
import type { ReactNode } from 'react';
import * as api from '../../lib/api.js';
import { useEntitlements } from '../../lib/entitlements-context.js';
import type { Capability } from '../../lib/capabilities.js';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 30_000;

/** 居中弹窗外壳(装备/退订共用)。 */
const Modal = ({ children }: { children: ReactNode }) => (
  <div style={{
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000,
  }}>
    <div className="card" style={{ width: 360, padding: 28, textAlign: 'center' }}>{children}</div>
  </div>
);

type EquipPhase = 'idle' | 'confirm' | 'posting' | 'polling' | 'ready' | 'failed' | 'timeout';

export const CapabilityEquip = ({ cap, onReady }: { cap: Capability; onReady?: () => void }) => {
  const ent = useEntitlements();
  const [phase, setPhase] = useState<EquipPhase>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const intervalRef = useRef<number | null>(null);

  const isActive = ent.observed.includes(cap.id);

  function cleanup() {
    if (timeoutRef.current) { window.clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    if (intervalRef.current) { window.clearInterval(intervalRef.current); intervalRef.current = null; }
  }
  useEffect(() => cleanup, []);

  useEffect(() => {
    if (phase === 'polling' && isActive) {
      cleanup();
      setPhase('ready');
      onReady?.();
    }
  }, [phase, isActive, onReady]);

  async function handleEnable(): Promise<void> {
    setPhase('posting');
    setErrorMsg(null);
    try {
      await api.enableFeature(cap.id);
      setPhase('polling');
      intervalRef.current = window.setInterval(() => { void ent.refetch(); }, POLL_INTERVAL_MS);
      timeoutRef.current = window.setTimeout(() => { cleanup(); setPhase('timeout'); }, POLL_TIMEOUT_MS);
      void ent.refetch();
    } catch (err) {
      setPhase('failed');
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }

  if (isActive && phase !== 'polling' && phase !== 'posting') {
    return <button className="btn" disabled style={{ background: '#16a34a', color: 'white' }}>✓ 已装备</button>;
  }

  const copy = cap.enableCopy;
  return (
    <>
      <button
        className="btn btn-primary"
        onClick={() => setPhase('confirm')}
        disabled={phase !== 'idle' && phase !== 'failed' && phase !== 'timeout'}
        style={{ background: '#0ea5e9' }}
      >
        购买并装备
      </button>

      {(phase === 'confirm' || phase === 'posting' || phase === 'polling' || phase === 'failed' || phase === 'timeout') && (
        <Modal>
          <div style={{ marginBottom: 10, display: 'flex', justifyContent: 'center' }}>{cap.icon}</div>
          {phase === 'confirm' && copy && (
            <>
              <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>{copy.title}</div>
              <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>{copy.desc}</div>
              {copy.lines?.map((l, i) => (
                <div key={i} style={{ fontSize: 13, marginBottom: 4 }}>{l}</div>
              ))}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 14 }}>
                <button className="btn" onClick={() => setPhase('idle')}>取消</button>
                <button className="btn btn-primary" style={{ background: '#0ea5e9' }} onClick={() => void handleEnable()}>
                  确认购买并装备
                </button>
              </div>
            </>
          )}
          {phase === 'posting' && <div style={{ fontWeight: 600 }}>正在记录订单…</div>}
          {phase === 'polling' && (
            <>
              <div style={{ fontWeight: 600 }}>正在装备到助理…</div>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>预计 5 - 15 秒</div>
            </>
          )}
          {phase === 'failed' && (
            <>
              <div style={{ fontWeight: 600, color: 'var(--err, #c00)' }}>购买失败</div>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{errorMsg}</div>
              <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'center' }}>
                <button className="btn" onClick={() => setPhase('idle')}>关闭</button>
                <button className="btn btn-primary" onClick={() => void handleEnable()}>重新购买</button>
              </div>
            </>
          )}
          {phase === 'timeout' && (
            <>
              <div style={{ fontWeight: 600 }}>装备未完成</div>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>请稍后在"我的助理"重试</div>
              <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'center' }}>
                <button className="btn" onClick={() => setPhase('idle')}>关闭</button>
                <button className="btn btn-primary" onClick={() => void handleEnable()}>立即重试</button>
              </div>
            </>
          )}
        </Modal>
      )}
    </>
  );
};

type RemovePhase = 'idle' | 'confirm' | 'posting' | 'polling' | 'done' | 'failed' | 'timeout';

export const CapabilityRemove = ({ cap, trigger }: { cap: Capability; trigger: (open: () => void) => ReactNode }) => {
  const ent = useEntitlements();
  const [phase, setPhase] = useState<RemovePhase>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const intervalRef = useRef<number | null>(null);

  const stillActive = ent.observed.includes(cap.id);

  function cleanup() {
    if (timeoutRef.current) { window.clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    if (intervalRef.current) { window.clearInterval(intervalRef.current); intervalRef.current = null; }
  }
  useEffect(() => cleanup, []);

  useEffect(() => {
    if (phase === 'polling' && !stillActive) {
      cleanup();
      setPhase('done');
      window.setTimeout(() => setPhase('idle'), 800);
    }
  }, [phase, stillActive]);

  async function handleDisable(): Promise<void> {
    setPhase('posting');
    setErrorMsg(null);
    try {
      await api.disableFeature(cap.id);
      setPhase('polling');
      intervalRef.current = window.setInterval(() => { void ent.refetch(); }, POLL_INTERVAL_MS);
      timeoutRef.current = window.setTimeout(() => { cleanup(); setPhase('timeout'); }, POLL_TIMEOUT_MS);
      void ent.refetch();
    } catch (err) {
      setPhase('failed');
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }

  const copy = cap.disableCopy;
  return (
    <>
      {trigger(() => setPhase('confirm'))}

      {(phase === 'confirm' || phase === 'posting' || phase === 'polling' || phase === 'failed' || phase === 'timeout') && (
        <Modal>
          <div style={{ marginBottom: 10, display: 'flex', justifyContent: 'center' }}>{cap.icon}</div>
          {phase === 'confirm' && copy && (
            <>
              <div style={{ fontWeight: 600, marginBottom: 10 }}>{copy.title}</div>
              <div className="muted" style={{ fontSize: 13, marginBottom: 16, textAlign: 'left' }}>
                {copy.desc}
                {copy.lines?.map((l, i) => (<div key={i}>{l}</div>))}
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                <button className="btn" onClick={() => setPhase('idle')}>取消</button>
                <button className="btn btn-primary" style={{ background: '#dc2626' }} onClick={() => void handleDisable()}>确认退订</button>
              </div>
            </>
          )}
          {phase === 'posting' && <div style={{ fontWeight: 600 }}>正在记录退订…</div>}
          {phase === 'polling' && (
            <>
              <div style={{ fontWeight: 600 }}>正在卸载…</div>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>预计 5 - 15 秒</div>
            </>
          )}
          {phase === 'failed' && (
            <>
              <div style={{ fontWeight: 600, color: 'var(--err, #c00)' }}>退订失败</div>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{errorMsg}</div>
              <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'center' }}>
                <button className="btn" onClick={() => setPhase('idle')}>关闭</button>
                <button className="btn btn-primary" onClick={() => void handleDisable()}>重试</button>
              </div>
            </>
          )}
          {phase === 'timeout' && (
            <>
              <div style={{ fontWeight: 600 }}>退订未完成</div>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>请稍后重试</div>
              <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'center' }}>
                <button className="btn" onClick={() => setPhase('idle')}>关闭</button>
                <button className="btn btn-primary" onClick={() => void handleDisable()}>立即重试</button>
              </div>
            </>
          )}
        </Modal>
      )}
    </>
  );
};
```

- [ ] **Step 4: 跑组件测试看通过**

Run: `pnpm --filter @lingxi/web exec vitest run test/CapabilityAction.test.tsx`
Expected: PASS(CapabilityEquip 4 + CapabilityRemove 1)。

- [ ] **Step 5: 跑 catalog 测试(回归)**

Run: `pnpm --filter @lingxi/web exec vitest run test/capabilities.test.tsx`
Expected: PASS。

- [ ] **Step 6: 类型检查(此时 ManageApp 仍引用旧按钮 + 旧 api,预期仍有报错)**

Run: `pnpm --filter @lingxi/web lint`
Expected: 仅 `ManageApp.tsx` / `BuyCloudButton.tsx` / `DisableCloudButton.tsx` 相关报错(它们 Task 7 处理)。capabilities.tsx / CapabilityAction.tsx 自身**无**报错。

- [ ] **Step 7: 删除多余的 accentIcon(若实现时误加)**

确认 `apps/web/src/lib/capabilities.tsx` 中**没有**未使用的 `accentIcon` 常量(Task 3 Step 3 提醒)。

- [ ] **Step 8: Commit(Task 2 + 3 + 4 一并提交,仓库到此前不可单独编译,故合并提交前端基建)**

```bash
git add apps/web/src/lib/api.ts apps/web/src/lib/capabilities.tsx apps/web/src/apps/manage/CapabilityAction.tsx apps/web/test/capabilities.test.tsx apps/web/test/CapabilityAction.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): 能力目录 catalog + 通用装备/移除组件 + api 通用化

新增 lib/capabilities.tsx 单一数据源(web/file/wechat 默认 + cloud 可装备)。
新增 CapabilityEquip/CapabilityRemove 取代 Buy/DisableCloudButton 的状态机, 参数化到任意能力。
api enableCloud/disableCloud → enableFeature/disableFeature。
注: ManageApp 尚未切换, 全量编译在 Task 7 后恢复。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Dock 由 catalog 驱动条件 app

**Files:**
- Modify: `apps/web/src/desktop/Dock.tsx`
- Test: `apps/web/test/Dock.test.tsx`(现有用例应继续通过,不改)

- [ ] **Step 1: 先跑现有 Dock 测试确认基线绿**

Run: `pnpm --filter @lingxi/web exec vitest run test/Dock.test.tsx`
Expected: PASS(4 个用例:base apps、无 cloud 隐藏文件、有 cloud 显示文件、点击 onOpen('files'))。

- [ ] **Step 2: 改实现 —— conditionalApps 改由 catalog `desktopApp` 派生**

把 `apps/web/src/desktop/Dock.tsx` 整体替换为:

```tsx
import type { ReactNode } from 'react';
import { IconSpark, IconGrid, IconFolder } from '../lib/icons.js';
import { CAPABILITIES } from '../lib/capabilities.js';

export type DockAppId = 'chat' | 'manage' | 'files';

interface AppDef { id: DockAppId; name: string; icon: ReactNode; c1: string; c2: string }

const baseApps: AppDef[] = [
  { id: 'chat',   name: '灵犀助理', icon: <IconSpark size={24} />, c1: '#8b5cf6', c2: '#6d28d9' },
  { id: 'manage', name: '我的助理', icon: <IconGrid size={24} />,  c1: '#3b82f6', c2: '#1d4ed8' },
];

/** 桌面 app 的视觉(颜色/Dock 尺寸图标),按 desktopApp id 索引。catalog 决定"是否出现", 这里决定"长什么样"。 */
const dockVisuals: Record<string, { name: string; icon: ReactNode; c1: string; c2: string }> = {
  files: { name: '文件', icon: <IconFolder size={24} />, c1: '#22c55e', c2: '#15803d' },
};

interface DockProps {
  onOpen: (id: DockAppId) => void;
  openApps: ReadonlySet<string>;
  entitlements: string[];
}

export const Dock = ({ onOpen, openApps, entitlements }: DockProps) => {
  const conditional: AppDef[] = CAPABILITIES
    .filter((c) => c.desktopApp && entitlements.includes(c.id) && dockVisuals[c.desktopApp])
    .map((c) => ({ id: c.desktopApp as DockAppId, ...dockVisuals[c.desktopApp!]! }));

  const apps: AppDef[] = [...baseApps, ...conditional];

  return (
    <div style={{
      position: 'absolute', bottom: 9, left: '50%', transform: 'translateX(-50%)',
      display: 'flex', alignItems: 'flex-end', gap: 11, padding: '8px 11px',
      borderRadius: 22, zIndex: 1000,
      background: 'rgba(255,255,255,0.32)',
      backdropFilter: 'blur(26px) saturate(180%)',
      border: '1px solid rgba(255,255,255,0.5)',
      boxShadow: '0 14px 44px rgba(0,0,0,0.3)',
    }}>
      {apps.map((a) => (
        <button key={a.id} title={a.name} onClick={() => onOpen(a.id)} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div style={{
            width: 52, height: 52, borderRadius: 14, display: 'flex',
            alignItems: 'center', justifyContent: 'center', color: '#fff',
            background: `linear-gradient(160deg, ${a.c1}, ${a.c2})`,
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.5), 0 7px 16px rgba(0,0,0,0.22)',
            transition: 'transform 0.18s cubic-bezier(0.25,1.4,0.5,1)',
          }}>{a.icon}</div>
          <span style={{ width: 4, height: 4, borderRadius: '50%', background: 'rgba(0,0,0,0.5)', marginTop: 4, opacity: openApps.has(a.id) ? 1 : 0 }} />
        </button>
      ))}
    </div>
  );
};
```

- [ ] **Step 3: 跑 Dock 测试看仍通过(行为不变,实现来源从硬编码改 catalog)**

Run: `pnpm --filter @lingxi/web exec vitest run test/Dock.test.tsx`
Expected: PASS(4 个用例全绿)。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/desktop/Dock.tsx
git commit -m "$(cat <<'EOF'
refactor(web): Dock 条件 app 改由 capabilities catalog 驱动

去掉硬编码 conditionalApps{cloud}, 改扫 CAPABILITIES 的 desktopApp + observed。视觉(颜色/图标)留在 dockVisuals。行为与改造前一致。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Desktop "新装备即开窗" 由 catalog 驱动

**Files:**
- Modify: `apps/web/src/desktop/Desktop.tsx:52-61`

- [ ] **Step 1: 替换 cloud 专属的开窗 effect 为 catalog 驱动**

在 `apps/web/src/desktop/Desktop.tsx`:

(a) 顶部 import 区加:

```tsx
import { CAPABILITIES } from '../lib/capabilities.js';
```

(b) 把这段(当前 52-61 行):

```tsx
  const cloudObservedRef = useRef(observed.includes('cloud'));

  useEffect(() => {
    const had = cloudObservedRef.current;
    const has = observed.includes('cloud');
    if (!had && has) {
      openApp('files');
    }
    cloudObservedRef.current = has;
  }, [observed]);
```

替换为:

```tsx
  // 记录上一轮 observed,任一带 desktopApp 的能力"新被装备"时自动开窗。
  const prevObservedRef = useRef<string[]>(observed);

  useEffect(() => {
    const prev = new Set(prevObservedRef.current);
    for (const cap of CAPABILITIES) {
      if (cap.desktopApp && observed.includes(cap.id) && !prev.has(cap.id)) {
        openApp(cap.desktopApp as AppId);
      }
    }
    prevObservedRef.current = observed;
  }, [observed]);
```

> `useRef` 已在文件顶部 `import { useState, useEffect, useRef } from 'react';` 引入,无需改 import。`openApp` / `AppId` 已在作用域内。

- [ ] **Step 2: 类型检查(Desktop 这块应无报错;ManageApp 仍待 Task 7)**

Run: `pnpm --filter @lingxi/web lint`
Expected: 仅剩 `ManageApp.tsx` + 待删的 `BuyCloudButton.tsx`/`DisableCloudButton.tsx` 报错。Desktop.tsx 无报错。

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/desktop/Desktop.tsx
git commit -m "$(cat <<'EOF'
refactor(web): Desktop 装备即开窗改由 catalog 驱动

cloudObservedRef 专属逻辑改为扫 CAPABILITIES.desktopApp + observed diff, 任一带桌面 app 的能力新装备时自动开窗。cloud→files 行为不变。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: ManageApp 重写为装备/市场两 tab + 删旧按钮

**Files:**
- Modify: `apps/web/src/apps/manage/ManageApp.tsx`(整体重写)
- Delete: `apps/web/src/apps/manage/BuyCloudButton.tsx`, `apps/web/src/apps/manage/DisableCloudButton.tsx`
- Delete: `apps/web/test/BuyCloudButton.test.tsx`, `apps/web/test/DisableCloudButton.test.tsx`
- Test: `apps/web/test/ManageApp.test.tsx`(新建)

- [ ] **Step 1: 写 ManageApp 失败测试**

创建 `apps/web/test/ManageApp.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ManageApp } from '../src/apps/manage/ManageApp.js';
import { EntitlementsProvider } from '../src/lib/entitlements-context.js';

vi.mock('../src/lib/api.js', () => ({
  enableFeature: vi.fn(),
  disableFeature: vi.fn(),
  status: vi.fn(),
  getMyWechatBind: vi.fn().mockResolvedValue({ bound: false }),
  AuthError: class extends Error {},
}));
import * as api from '../src/lib/api.js';

vi.mock('../src/auth/AuthContext.js', () => ({
  useAuth: () => ({ status: 'authenticated', user: { nickname: '测试用户' } }),
}));

function setObserved(observed: string[]) {
  vi.mocked(api.status).mockResolvedValue({
    status: 'ready', provisioning_step: null, progress_pct: 100, error_message: null,
    entitlements_desired: observed, entitlements_observed: observed, container_token_version: 1,
  });
}

const renderApp = () =>
  render(<EntitlementsProvider><ManageApp onOpenWechat={vi.fn()} /></EntitlementsProvider>);

describe('ManageApp', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); setObserved([]); });
  afterEach(() => { vi.useRealTimers(); });

  it('装备 tab 默认显示 3 个基线能力,不含云盘', async () => {
    renderApp();
    await waitFor(() => expect(screen.getByText('联网搜索')).toBeInTheDocument());
    expect(screen.getByText('文件读写')).toBeInTheDocument();
    expect(screen.getByText('微信收发')).toBeInTheDocument();
    expect(screen.getByText(/已装备能力 · 3/)).toBeInTheDocument();
  });

  it('切到市场 tab,云盘显示"购买并装备"', async () => {
    renderApp();
    await waitFor(() => expect(screen.getByText('联网搜索')).toBeInTheDocument());
    fireEvent.click(screen.getByText('市场'));
    await waitFor(() => expect(screen.getByText(/购买并装备/)).toBeInTheDocument());
  });

  it('observed 含 cloud:装备 tab 计 4 且有云盘卡', async () => {
    setObserved(['cloud']);
    renderApp();
    await waitFor(() => expect(screen.getByText(/已装备能力 · 4/)).toBeInTheDocument());
    expect(screen.getByText('云盘')).toBeInTheDocument();
  });

  it('「添加能力」按钮切到市场 tab', async () => {
    renderApp();
    await waitFor(() => expect(screen.getByText('联网搜索')).toBeInTheDocument());
    fireEvent.click(screen.getByText(/添加能力/));
    await waitFor(() => expect(screen.getByText(/购买并装备/)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: 跑测试看失败**

Run: `pnpm --filter @lingxi/web exec vitest run test/ManageApp.test.tsx`
Expected: FAIL(当前 ManageApp 无 tab、引用旧按钮)。

- [ ] **Step 3: 整体重写 ManageApp.tsx**

把 `apps/web/src/apps/manage/ManageApp.tsx` 整体替换为:

```tsx
import { useEffect, useState } from 'react';
import type { Capability } from '../../lib/capabilities.js';
import { useAuth } from '../../auth/AuthContext.js';
import { IconSpark, IconMessage, IconPlus } from '../../lib/icons.js';
import { useEntitlements } from '../../lib/entitlements-context.js';
import { getMyWechatBind } from '../../lib/api.js';
import { CAPABILITIES, MARKET_CAPABILITIES, isEquipped } from '../../lib/capabilities.js';
import { CapabilityEquip, CapabilityRemove } from './CapabilityAction.js';

type Tab = 'equip' | 'market';

const EquipTab = ({ equipped, onAdd }: { equipped: Capability[]; onAdd: () => void }) => (
  <>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
      <div style={{ fontSize: 15, fontWeight: 600 }}>已装备能力 · {equipped.length}</div>
      <button className="btn btn-soft" onClick={onAdd} style={{ padding: '6px 12px', fontSize: 13 }}>
        <IconPlus size={14} /> 添加能力
      </button>
    </div>
    <div style={{ display: 'grid', gap: 13, gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
      {equipped.map((c) => (
        <div key={c.id} style={{ position: 'relative', padding: 14, border: '1px solid var(--accent)', background: 'var(--accent-weak2)', borderRadius: 12 }}>
          {c.removable && (
            <CapabilityRemove cap={c} trigger={(open) => (
              <button
                onClick={open}
                title={`退订${c.name}`}
                style={{ position: 'absolute', top: 6, right: 8, background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--muted)', fontSize: 14 }}
              >
                ✕
              </button>
            )} />
          )}
          {c.icon}
          <div style={{ fontWeight: 600, marginTop: 10 }}>{c.name}</div>
          <div style={{ fontSize: 12, marginTop: 2, color: 'var(--accent-d)' }}>已装备</div>
        </div>
      ))}
    </div>
  </>
);

const MarketTab = ({ observed }: { observed: string[] }) => (
  <div style={{ display: 'grid', gap: 13, gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
    {MARKET_CAPABILITIES.map((c) => {
      const owned = observed.includes(c.id);
      return (
        <div key={c.id} className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {c.icon}
            <div style={{ fontWeight: 600 }}>{c.name}</div>
          </div>
          <div className="muted" style={{ fontSize: 12, flex: 1 }}>{c.blurb}</div>
          <div style={{ fontSize: 12, color: 'var(--accent-d)' }}>价格: {c.price === 0 ? '免费' : `¥${c.price}`}</div>
          <div>
            {owned
              ? <button className="btn" disabled style={{ background: '#16a34a', color: 'white' }}>✓ 已装备</button>
              : <CapabilityEquip cap={c} />}
          </div>
        </div>
      );
    })}
  </div>
);

export const ManageApp = ({ onOpenWechat }: { onOpenWechat: () => void }) => {
  const auth = useAuth();
  const nick = auth.status === 'authenticated' ? auth.user.nickname ?? '未命名' : '';
  const ent = useEntitlements();
  const [tab, setTab] = useState<Tab>('equip');

  // 拉微信绑定状态决定按钮文案 (绑定 / 解绑)。null = 还没拿到 → 不显示文案避免闪烁。
  const [wechatBound, setWechatBound] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    const timeoutId = window.setTimeout(() => { if (!cancelled) setWechatBound(false); }, 5000);
    void getMyWechatBind()
      .then((info) => { if (!cancelled) { window.clearTimeout(timeoutId); setWechatBound(info.bound); } })
      .catch(() => { if (!cancelled) { window.clearTimeout(timeoutId); setWechatBound(false); } });
    return () => { cancelled = true; window.clearTimeout(timeoutId); };
  }, []);

  const equipped = CAPABILITIES.filter((c) => isEquipped(c, ent.observed));

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 22 }}>
      <div style={{ maxWidth: 880, margin: '0 auto' }}>
        <div className="card" style={{ padding: 18, display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
          <span style={{ display: 'inline-flex', width: 52, height: 52, borderRadius: 14, background: '#7c3aed1f', color: '#7c3aed', alignItems: 'center', justifyContent: 'center' }}>
            <IconSpark size={26} strokeWidth={1.9} />
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 650, fontSize: 16 }}>灵犀助理</div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>
              <span className="pulse" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--ok)', display: 'inline-block', marginRight: 6 }} />
              在线 · {nick} 的助理
            </div>
          </div>
          <button
            className="btn btn-primary"
            style={{ background: wechatBound ? '#6b7280' : '#16a34a' }}
            onClick={onOpenWechat}
            title={wechatBound ? '查看绑定 / 解绑' : '通过扫码绑定微信'}
          >
            <IconMessage size={15} />
            {wechatBound === null ? '微信…' : wechatBound ? '解绑微信' : '绑定微信'}
          </button>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
          <button
            className="btn"
            onClick={() => setTab('equip')}
            style={{ fontWeight: tab === 'equip' ? 700 : 500, background: tab === 'equip' ? 'var(--accent-weak2)' : undefined }}
          >
            装备
          </button>
          <button
            className="btn"
            onClick={() => setTab('market')}
            style={{ fontWeight: tab === 'market' ? 700 : 500, background: tab === 'market' ? 'var(--accent-weak2)' : undefined }}
          >
            市场
          </button>
        </div>

        {tab === 'equip'
          ? <EquipTab equipped={equipped} onAdd={() => setTab('market')} />
          : <MarketTab observed={ent.observed} />}
      </div>
    </div>
  );
};
```

- [ ] **Step 4: 删除旧的云盘专属按钮 + 其测试**

```bash
git rm apps/web/src/apps/manage/BuyCloudButton.tsx \
       apps/web/src/apps/manage/DisableCloudButton.tsx \
       apps/web/test/BuyCloudButton.test.tsx \
       apps/web/test/DisableCloudButton.test.tsx
```

- [ ] **Step 5: 跑 ManageApp 测试看通过**

Run: `pnpm --filter @lingxi/web exec vitest run test/ManageApp.test.tsx`
Expected: PASS(4 个用例)。

- [ ] **Step 6: 全 web 类型检查应彻底干净**

Run: `pnpm --filter @lingxi/web lint`
Expected: 无错误(旧按钮已删,ManageApp 改用新组件 + 新 api)。

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/apps/manage/ManageApp.tsx apps/web/test/ManageApp.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): ManageApp 重写为装备/市场两 tab, 删云盘专属按钮

按原型模型: 装备 tab(已装备网格 + 添加能力→市场, removable 卡带 ✕) / 市场 tab(MARKET_CAPABILITIES 网格, 购买并装备 or 已装备)。
删除 BuyCloudButton/DisableCloudButton 及其测试, 全部走通用 CapabilityEquip/CapabilityRemove。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: 全量验证 + 手动 e2e

**Files:** 无(验证任务)

- [ ] **Step 1: 全 web 测试**

Run: `pnpm --filter @lingxi/web test`
Expected: 全绿。其中应**不再**有 `BuyCloudButton.test` / `DisableCloudButton.test`(已删),应**有** `capabilities` / `CapabilityAction` / `ManageApp` / `Dock` 等。

- [ ] **Step 2: 全 gateway 测试**

Run: `pnpm --filter @lingxi/gateway test`
Expected: 全绿(含 entitlements 参数化 + 白名单用例)。

- [ ] **Step 3: 双端类型检查**

Run: `pnpm --filter @lingxi/web lint && pnpm --filter @lingxi/gateway lint`
Expected: 均无错误。

- [ ] **Step 4: 手动 e2e(本地 dev,验证回归 —— 重构不能改变云盘既有行为)**

启动:`pnpm dev`(需本地 docker + supabase + .env.local,见 CLAUDE.md)。然后在浏览器:

1. 打开「我的助理」→ 见「装备 / 市场」两 tab,装备 tab 列出 联网搜索 / 文件读写 / 微信收发 三张卡(无 ✕)。
2. 切「市场」→ 见「云盘」卡,显示「购买并装备」。
3. 点「购买并装备」→ 确认弹窗显示「价格: 免费（后续可能收费）/ 容量: 无限制」→ 确认 → 轮询 →「正在装备」→ 完成。
4. 装备成功后:Dock 出现「文件」图标且**自动开窗**(Desktop 联动)。装备 tab 计数变 4,出现「云盘」卡带 ✕。
5. 点云盘卡 ✕ → 退订确认弹窗(「桌面"文件"应用会消失 / 文件保留」)→ 确认 → 轮询 → 桌面「文件」消失,云盘卡回到市场显示「购买并装备」。

任一步与改造前行为不一致 → 回到对应 Task 修。

- [ ] **Step 5: (无新代码,无需 commit)** 验证全过 → 子项 A 完成,可开始子项 B(邮件)。

---

## Self-Review 记录

- **Spec 覆盖**:装备/市场两 tab(Task 7)、数据驱动 catalog(Task 3)、通用装备/移除(Task 4)、云盘收编(Task 4+7)、路由 `:feature`+白名单(Task 1)、Dock/Desktop catalog 驱动(Task 5/6)、只放已实现能力无灰卡无专家(catalog 仅含 web/file/wechat/cloud)。spec §一~§七 均有对应任务。
- **email 边界**:本计划**不含** email 条目与白名单 `email`(spec B 负责),Task 1 白名单注释 + Task 7 测试已显式断言 A 阶段 email 仍 404,防止提前泄漏半成品。
- **类型一致**:`enableFeature`/`disableFeature`(api)、`CapabilityEquip`/`CapabilityRemove`(组件)、`CAPABILITIES`/`MARKET_CAPABILITIES`/`getCapability`/`isEquipped`(catalog)、`Capability`/`CapabilityCopy`(类型)全程一致;`desktopApp` 在 catalog/Dock/Desktop 三处用法一致。
- **编译连续性**:Task 2 起仓库短暂不可整体编译(ManageApp 仍引用旧符号),到 Task 4 Step 8 合并提交前端基建、Task 7 完成切换后恢复;每个 commit 节点本身可编译可测试(Task 1 独立绿;Task 4 提交时 capabilities/CapabilityAction 自测绿且不破坏已存在的旧按钮测试——旧按钮+旧 api 已删?**否**:Task 4 时旧按钮仍在并仍引用已删的 enableCloud → 旧按钮测试会红)。**执行要点见下方"提交顺序补充"。**

### 提交顺序补充(重要)

旧 `BuyCloudButton`/`DisableCloudButton` 在 Task 2 删除 `enableCloud`/`disableCloud` 后即无法编译,其测试会红。为保证"每次 commit 绿":**Task 4 Step 8 的提交应同时包含 Task 7 Step 4 的删除操作**,即把"删旧按钮+旧测试"提到与前端基建同一个 commit。执行者请按此调整:在 Task 4 Step 8 前先执行 Task 7 Step 4 的 `git rm`,使该 commit 一次性达成可编译可测试状态。Task 7 其余步骤(ManageApp 重写 + 新测试)随后单独提交。
