# 装备能力轻量 resync(免滚 revision)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 装备(enable)能力时,gateway 把 desired 直接推给热容器建软链并在同一响应拿回 observed,免 bump token_version、免滚 ACA revision,消灭"第一次显示装备失败、几十秒后才成功"的假失败。

**Architecture:** 方案 A(同步推送式 resync)。容器新增 `POST /internal/resync-entitlements`(过现有 `requireBearer`,不校 token_version),body 带 desired,容器建/删软链后响应体返回 `{observed, token_version}`。gateway 新增 `resyncEntitlements(userId)`:读 desired → 现签 token → POST 容器 → 落 observed + 对齐 policy_hash,**不 bump、不 reconcile**。enable 路由改调 resync;disable 路由原样保留 bump + reconcile。前端等待弹窗 block 界面、超时从 30s 放宽到 180s。

**Tech Stack:** 容器侧 Bun + TypeScript(`docker/hermes/server` + `scripts`,`bun test`);gateway Express + TypeScript(`apps/gateway`,vitest);前端 Vite + React(`apps/web`,vitest + @testing-library/react)。

## Global Constraints

- 范围**仅 enable**。disable 路径一行不动(保留 `bumpTokenVersion` + `syncUserContainer`/reconcile)。
- enable **绝不 bump token_version**:加技能是纯加法,不吊销任何 token;不 bump 才能让容器自带 baked token 继续 outbound 有效(boot-sync 安全网能回报 observed)。
- resync **不滚 revision**:技能是 `~/.hermes/skills/<feature>` 软链,Hermes CLI 每条消息现 spawn 时重读该目录,装备本身不需要重启。
- `applyEntitlements` 必须**声明式幂等**(按 desired 建/删软链,可安全重复调用)。
- 容器侧运行时是 Bun 直接跑 `.ts`,**无 node_modules**,只能用 `node:*` 内置 + `bun:test`。
- 代码注释 / 文档默认中文(CLAUDE.md 语言守则)。
- 红线:任何云上 build / deploy 须先获用户明示同意。本计划**只写代码 + 本地测试**,不触发任何云上动作。
- 工作目录:worktree `worktree-explore+entitlement-live-resync`,所有路径相对其根。

---

## File Structure

**容器侧(`docker/hermes/`)**
- Modify `scripts/sync-entitlements.ts` — 抽出纯函数 `applyEntitlements(desired, skillsDir?, sourceDir?)`,`runSyncEntitlements` 复用它。
- Create `test/apply-entitlements.test.ts` — `applyEntitlements` 对临时目录的软链/去链幂等单测(bun)。
- Modify `server/http.ts` — 新增 `POST /internal/resync-entitlements` 路由 + `handleResyncEntitlements(req, apply?)` handler。
- Create `test/resync-endpoint.test.ts` — handler 解析 body + 返回 `{observed, token_version}` 单测(bun)。

**Gateway(`apps/gateway/`)**
- Modify `src/provisioning/manager.ts` — 新增 `resyncEntitlements(userId)`。
- Create `test/provisioning/resync.test.ts` — mock fetch + dao,断言 observed 落库 + setPolicyHash + 不 bump(vitest)。
- Modify `src/api/entitlements.ts` — enable 路由改调 `resyncEntitlements`(不 bump);disable 路由保留旧逻辑。
- Modify `test/api/entitlements.test.ts` — 更新 enable/disable 断言。

**前端(`apps/web/`)**
- Modify `src/apps/manage/BuyCloudButton.tsx` — 180s 超时 + 文案 + block 弹窗。
- Modify `src/apps/manage/CapabilityAction.tsx` — `CapabilityEquip` 同步改造(`CapabilityRemove` 不动)。
- Create `test/BuyCloudButton.test.tsx` — 装备状态机单测(vitest + fake timers)。

---

## Task 1: 容器侧抽出 `applyEntitlements` 纯函数

**Files:**
- Modify: `docker/hermes/scripts/sync-entitlements.ts`
- Test: `docker/hermes/test/apply-entitlements.test.ts`

**Interfaces:**
- Consumes: 现有 `log` / `warn`(from `./lib.ts`),`node:fs` 同步 API。
- Produces: `export function applyEntitlements(desired: string[], skillsDir?: string, sourceDir?: string): string[]` — 在 `skillsDir` 里按 `desired` 声明式建/删软链(target 取 `sourceDir/<feature>`),返回真正建成的 `observed`(`desired` 里 target 存在且建链成功的子集)。默认 `skillsDir=SKILLS_DIR`、`sourceDir=SKILLS_SOURCE`。

- [ ] **Step 1: 写失败测试**

Create `docker/hermes/test/apply-entitlements.test.ts`:

```ts
// apply-entitlements.test.ts — applyEntitlements 软链收敛单测 (bun test)。
// 给临时 skillsDir + sourceDir, 不碰真 HOME, 验证:
//   - desired 里 source 存在的建成软链并出现在 observed
//   - desired 里 source 不存在的跳过, 不进 observed
//   - 不在 desired 的 stale 软链被删
//   - 重复调用幂等 (observed 稳定, 软链不重复堆叠)
//   - skillsDir 不存在时自动 mkdir, 不抛

import { test, expect, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { lstatSync, readlinkSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { applyEntitlements } from '../scripts/sync-entitlements.ts';

let roots: string[] = [];
afterEach(async () => { for (const d of roots) await rm(d, { recursive: true, force: true }); roots = []; });

// 造一个 sourceDir(含若干已安装 skill 目录) + 空 skillsDir, 返回两者路径。
const makeDirs = async (installed: string[]): Promise<{ skillsDir: string; sourceDir: string }> => {
  const base = await mkdtemp(path.join(tmpdir(), 'hermes-apply-'));
  roots.push(base);
  const skillsDir = path.join(base, 'skills');
  const sourceDir = path.join(base, 'source');
  await mkdir(sourceDir, { recursive: true });
  for (const name of installed) {
    await mkdir(path.join(sourceDir, name), { recursive: true });
    await writeFile(path.join(sourceDir, name, 'SKILL.md'), 'x');
  }
  return { skillsDir, sourceDir };
};

test('links desired skills whose source exists, returns them as observed', async () => {
  const { skillsDir, sourceDir } = await makeDirs(['email', 'cloud']);
  const observed = applyEntitlements(['email', 'cloud'], skillsDir, sourceDir);
  expect(observed.sort()).toEqual(['cloud', 'email']);
  expect(lstatSync(path.join(skillsDir, 'email')).isSymbolicLink()).toBe(true);
  expect(readlinkSync(path.join(skillsDir, 'cloud'))).toBe(path.join(sourceDir, 'cloud'));
});

test('skips desired skill whose source is not installed', async () => {
  const { skillsDir, sourceDir } = await makeDirs(['email']);
  const observed = applyEntitlements(['email', 'ghost'], skillsDir, sourceDir);
  expect(observed).toEqual(['email']);
  expect(existsSync(path.join(skillsDir, 'ghost'))).toBe(false);
});

test('removes stale symlink no longer in desired', async () => {
  const { skillsDir, sourceDir } = await makeDirs(['email', 'cloud']);
  applyEntitlements(['email', 'cloud'], skillsDir, sourceDir);
  const observed = applyEntitlements(['email'], skillsDir, sourceDir);
  expect(observed).toEqual(['email']);
  expect(existsSync(path.join(skillsDir, 'cloud'))).toBe(false);
  expect(lstatSync(path.join(skillsDir, 'email')).isSymbolicLink()).toBe(true);
});

test('idempotent: repeated calls keep one symlink each, stable observed', async () => {
  const { skillsDir, sourceDir } = await makeDirs(['email']);
  applyEntitlements(['email'], skillsDir, sourceDir);
  const observed = applyEntitlements(['email'], skillsDir, sourceDir);
  expect(observed).toEqual(['email']);
  expect(readdirSync(skillsDir)).toEqual(['email']);
});

test('auto-mkdir skillsDir when absent, empty desired is no-op', async () => {
  const { skillsDir, sourceDir } = await makeDirs([]);
  const observed = applyEntitlements([], skillsDir, sourceDir);
  expect(observed).toEqual([]);
  expect(existsSync(skillsDir)).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd docker/hermes && bun test test/apply-entitlements.test.ts`
Expected: FAIL —— `applyEntitlements` 还没 export(`SyntaxError`/`undefined is not a function`)。

- [ ] **Step 3: 抽出 `applyEntitlements`**

在 `docker/hermes/scripts/sync-entitlements.ts` 顶部 `SKILLS_SOURCE` 常量之后,新增导出纯函数。把现有 `runSyncEntitlements` 里 `mkdirSync(SKILLS_DIR…)` 到收集 `observed` 的整段逻辑搬进来(参数化目录):

```ts
/**
 * 声明式收敛 skill 软链: 按 desired 在 skillsDir 建/删软链 (target = sourceDir/<feature>),
 * 返回真正建成的 observed (desired 里 target 存在且建链成功的子集)。幂等, 可安全重复调用。
 * 目录参数化是为了单测能喂临时目录, 生产默认 SKILLS_DIR / SKILLS_SOURCE。
 */
export function applyEntitlements(
  desired: string[],
  skillsDir: string = SKILLS_DIR,
  sourceDir: string = SKILLS_SOURCE,
): string[] {
  mkdirSync(skillsDir, { recursive: true });

  // 清掉不在 desired 里的 stale symlink
  for (const name of readdirSync(skillsDir)) {
    const p = `${skillsDir}/${name}`;
    try {
      if (!lstatSync(p).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    if (!desired.includes(name)) {
      log(`removing stale skill: ${name}`);
      try { unlinkSync(p); } catch (e) { warn(`unlink ${name} failed: ${(e as Error).message}`); }
    }
  }

  // 软链 desired (已存在的 symlink 先删再建, 保证 target 是最新的)
  const observed: string[] = [];
  for (const feature of desired) {
    const target = `${sourceDir}/${feature}`;
    const link = `${skillsDir}/${feature}`;
    if (!existsSync(target) || !statSync(target).isDirectory()) {
      warn(`skill ${feature} requested but not installed in image`);
      continue;
    }
    try {
      if (existsSync(link) || lstatSync(link).isSymbolicLink()) {
        try { unlinkSync(link); } catch {}
      }
    } catch {}
    try {
      symlinkSync(target, link);
      log(`linked skill: ${feature}`);
      observed.push(feature);
    } catch (e) {
      warn(`symlink ${feature} failed: ${(e as Error).message}`);
    }
  }
  return observed;
}
```

然后把 `runSyncEntitlements` 里原来那段(从 `mkdirSync(SKILLS_DIR, { recursive: true });` 到 `observed.push(feature)` 的 for 循环结束,即第 59–96 行)整体替换为一行:

```ts
  const observed = applyEntitlements(desired);
```

(保留其后的 `// 上报 observed` 块不变。)

- [ ] **Step 4: 跑测试确认通过**

Run: `cd docker/hermes && bun test test/apply-entitlements.test.ts`
Expected: PASS(5 个 test 全绿)。

- [ ] **Step 5: 回归 typecheck**

Run: `cd docker/hermes && pnpm typecheck`
Expected: 无新增类型错误。

- [ ] **Step 6: Commit**

```bash
git add docker/hermes/scripts/sync-entitlements.ts docker/hermes/test/apply-entitlements.test.ts
git commit -m "refactor(hermes): 抽出 applyEntitlements 纯函数(声明式软链收敛) + 单测"
```

---

## Task 2: 容器侧新增 `POST /internal/resync-entitlements` 端点

**Files:**
- Modify: `docker/hermes/server/http.ts`
- Test: `docker/hermes/test/resync-endpoint.test.ts`

**Interfaces:**
- Consumes: `applyEntitlements`(Task 1,from `../scripts/sync-entitlements.ts`)。
- Produces: 路由 `POST /internal/resync-entitlements`(过现有 `requireBearer`),请求体 `{ entitlements: string[], token_version: number }`,2xx 响应体 `{ observed: string[], token_version: number }`。导出 `handleResyncEntitlements(req: Request, apply?: (desired: string[]) => string[]): Promise<Response>`(`apply` 默认 `applyEntitlements`,留给单测注入假实现,避免碰真 `/home/hermes`)。

- [ ] **Step 1: 写失败测试**

Create `docker/hermes/test/resync-endpoint.test.ts`:

```ts
// resync-endpoint.test.ts — /internal/resync-entitlements handler 单测 (bun test)。
// 直接调 handleResyncEntitlements(req, fakeApply), 注入假 apply 不碰真 FS, 验证:
//   - 解析 body.entitlements 透传给 apply, 响应体回 {observed, token_version}
//   - apply 只在 desired 上调用一次
//   - 非法 JSON → 400
//   - entitlements 缺失 → 当空数组处理

import { test, expect } from 'bun:test';
import { handleResyncEntitlements } from '../server/http.ts';

const makeReq = (body: string): Request =>
  new Request('http://x/internal/resync-entitlements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

test('applies desired and returns observed + token_version', async () => {
  let seen: string[] | null = null;
  const fakeApply = (desired: string[]): string[] => { seen = desired; return ['email']; };
  const res = await handleResyncEntitlements(
    makeReq(JSON.stringify({ entitlements: ['email', 'ghost'], token_version: 7 })),
    fakeApply,
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ observed: ['email'], token_version: 7 });
  expect(seen).toEqual(['email', 'ghost']);
});

test('invalid JSON → 400, apply not called', async () => {
  let called = false;
  const res = await handleResyncEntitlements(makeReq('not-json'), () => { called = true; return []; });
  expect(res.status).toBe(400);
  expect(called).toBe(false);
});

test('missing entitlements → treated as empty desired', async () => {
  const res = await handleResyncEntitlements(makeReq(JSON.stringify({ token_version: 0 })), (d) => d);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ observed: [], token_version: 0 });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd docker/hermes && bun test test/resync-endpoint.test.ts`
Expected: FAIL —— `handleResyncEntitlements` 未导出。

- [ ] **Step 3: 实现 handler + 接线路由**

在 `docker/hermes/server/http.ts` 顶部 import 区追加:

```ts
import { applyEntitlements } from '../scripts/sync-entitlements.ts';
```

在 `handle()` 里、`requireBearer(req)` 放行之后、`/history` 分支之前(即第 44 行 `if (req.method === 'GET' && url.pathname === '/history')` 前一行)插入路由:

```ts
  if (req.method === 'POST' && url.pathname === '/internal/resync-entitlements') return handleResyncEntitlements(req);
```

在文件末尾(`handleDeleteSession` 之后)追加 handler:

```ts
interface ResyncRequestBody {
  entitlements?: string[];
  token_version?: number;
}

// POST /internal/resync-entitlements
//
// gateway 装备能力时推一份 desired 过来, 容器声明式建/删软链后在同一响应回 observed。
// 不回调 gateway、不重启 —— 软链即生效 (Hermes CLI 每条消息现 spawn 时重读 ~/.hermes/skills)。
// 过 requireBearer (与其它业务端点同, 见 handle()); 不校 token_version, 故能收 gateway 现签 token。
// apply 参数默认 applyEntitlements, 单测注入假实现避免碰真 FS。
export async function handleResyncEntitlements(
  req: Request,
  apply: (desired: string[]) => string[] = applyEntitlements,
): Promise<Response> {
  let body: ResyncRequestBody;
  try {
    body = (await req.json()) as ResyncRequestBody;
  } catch {
    return Response.json({ error: 'invalid json' }, { status: 400 });
  }
  const desired = Array.isArray(body.entitlements) ? body.entitlements : [];
  const tokenVersion = typeof body.token_version === 'number' ? body.token_version : 0;
  try {
    const observed = apply(desired);
    return Response.json({ observed, token_version: tokenVersion });
  } catch (e) {
    log.error({ event: 'resync.entitlements.failed', err: (e as Error).message });
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
```

> 注:`log` 已在 `http.ts` 顶部 `import { log } from './logger.ts';`(结构化日志,house style),沿用它而非 `console.error`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd docker/hermes && bun test test/resync-endpoint.test.ts`
Expected: PASS(3 个 test 全绿)。

- [ ] **Step 5: 容器侧全量回归**

Run: `cd docker/hermes && bun test && pnpm typecheck`
Expected: 全绿,无新增类型错误。

- [ ] **Step 6: Commit**

```bash
git add docker/hermes/server/http.ts docker/hermes/test/resync-endpoint.test.ts
git commit -m "feat(hermes): POST /internal/resync-entitlements 端点(推 desired→建软链→回 observed)"
```

---

## Task 3: Gateway 新增 `resyncEntitlements(userId)`

**Files:**
- Modify: `apps/gateway/src/provisioning/manager.ts`
- Test: `apps/gateway/test/provisioning/resync.test.ts`

**Interfaces:**
- Consumes: `dao.containerMapping.getByUserId`、`dao.entitlements.listActive`、`dao.users.getTokenVersion`、`dao.observedState.upsert`、`dao.containerMapping.setPolicyHash`(均已存在);`getContainerToken`(from `../lib/aca-call.js`);`azureModule.policyHashFor`(已 import 为 `azureModule`);全局 `fetch`。
- Produces: `export const resyncEntitlements: (userId: string) => Promise<void>` —— 读 desired + token_version → 现签容器 token → `POST {container_url}/internal/resync-entitlements` → 落 observed → 对齐 policy_hash。**不 bump、不 reconcile**。容器未 ready 时早退(desired 已落库,靠容器 bootstrap 安全网收敛)。

- [ ] **Step 1: 写失败测试**

Create `apps/gateway/test/provisioning/resync.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

import { dao } from '../../src/db/index.js';
import { resyncEntitlements } from '../../src/provisioning/manager.js';

const USER = 'u1';
const READY_ROW = {
  user_id: USER,
  container_name: 'hermes-u1',
  azure_files_share: 'user-u1',
  status: 'ready' as const,
  container_url: 'https://hermes-u1.example.com',
  provisioning_step: null,
  progress_pct: 100,
  error_message: null,
  policy_hash: 'oldhash',
  created_at: new Date().toISOString(),
  ready_at: new Date().toISOString(),
  assistant_name: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(dao.users.getTokenVersion).mockResolvedValue(3);
  vi.mocked(dao.entitlements.listActive).mockResolvedValue(['email']);
});

describe('resyncEntitlements', () => {
  it('ready container: POSTs desired, persists observed, aligns policy_hash, no bump', async () => {
    vi.mocked(dao.containerMapping.getByUserId).mockResolvedValue(READY_ROW as any);
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ observed: ['email'], token_version: 3 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await resyncEntitlements(USER);

    // 调对了容器端点 + 带 desired + Bearer
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://hermes-u1.example.com/internal/resync-entitlements');
    expect((init as any).method).toBe('POST');
    expect(JSON.parse((init as any).body)).toEqual({ entitlements: ['email'], token_version: 3 });
    expect((init as any).headers.Authorization).toMatch(/^Bearer .+/);

    // observed 落库 + policy_hash 对齐 + 绝不 bump
    expect(dao.observedState.upsert).toHaveBeenCalledWith({
      user_id: USER,
      observed_entitlements: ['email'],
      observed_token_version: 3,
    });
    expect(dao.containerMapping.setPolicyHash).toHaveBeenCalledWith(USER, expect.any(String));
    expect(dao.entitlements.bumpTokenVersion).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('container not ready: early return, no fetch, no observed write', async () => {
    vi.mocked(dao.containerMapping.getByUserId).mockResolvedValue(
      { ...READY_ROW, status: 'provisioning', container_url: null } as any,
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await resyncEntitlements(USER);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(dao.observedState.upsert).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('container non-2xx: throws (caller fire-and-forget logs; safety net covers)', async () => {
    vi.mocked(dao.containerMapping.getByUserId).mockResolvedValue(READY_ROW as any);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 503 })));

    await expect(resyncEntitlements(USER)).rejects.toThrow(/503/);
    expect(dao.observedState.upsert).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/gateway && pnpm vitest run test/provisioning/resync.test.ts`
Expected: FAIL —— `resyncEntitlements` 未导出。

- [ ] **Step 3: 实现 `resyncEntitlements`**

在 `apps/gateway/src/provisioning/manager.ts` 顶部 import 区追加(`config` import 之后):

```ts
import { getContainerToken } from '../lib/aca-call.js';
```

在文件末尾(`syncUserContainer` 之后)追加:

```ts
/** resync 容器调用的超时: 覆盖冷容器 0→1 唤醒最坏 (~冷启动 60-90s+); 超时则靠容器 bootstrap 安全网兜底。 */
const RESYNC_TIMEOUT_MS = 180_000;

/**
 * 装备(enable)轻量 resync (方案 A, 见 plans/2026-06-23-entitlement-live-resync):
 * 推 desired 给容器新端点, 容器建软链后同响应回 observed, 直接落库。不 bump token_version、不滚 revision。
 *  - 容器未 ready: 早退。desired 已在 DB, 待容器 bootstrap 的 sync-entitlements 自然读到并回报 (安全网)。
 *  - 现签当前版本 token (不 bump, 容器 requireBearer 不校 version, 天然收)。
 *  - 落 observed + 把 policy_hash 对齐当前策略 —— 否则下次聊天 checkAndReconcileACA 误判漂移再多滚一次 revision。
 * provisioner 不分支: azure / local 都走容器 HTTP (container_url 由 DB 给)。
 */
export const resyncEntitlements = async (userId: string): Promise<void> => {
  const mapping = await dao.containerMapping.getByUserId(userId);
  if (!mapping || mapping.status !== 'ready' || !mapping.container_url) {
    console.log(`[entitlements] resync skip (container not ready) for ${userId}`);
    return;
  }
  const desired = await dao.entitlements.listActive(userId);
  const tokenVersion = (await dao.users.getTokenVersion(userId)) ?? 0;
  const token = await getContainerToken(userId);

  const resp = await fetch(`${mapping.container_url}/internal/resync-entitlements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ entitlements: desired, token_version: tokenVersion }),
    signal: AbortSignal.timeout(RESYNC_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`resync HTTP ${resp.status}`);

  const data = (await resp.json()) as { observed?: string[]; token_version?: number };
  const observed = Array.isArray(data.observed) ? data.observed : [];
  await dao.observedState.upsert({
    user_id: userId,
    observed_entitlements: observed,
    observed_token_version: typeof data.token_version === 'number' ? data.token_version : tokenVersion,
  });
  await dao.containerMapping.setPolicyHash(userId, azureModule.policyHashFor(userId));
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/gateway && pnpm vitest run test/provisioning/resync.test.ts`
Expected: PASS(3 个 it 全绿)。

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/provisioning/manager.ts apps/gateway/test/provisioning/resync.test.ts
git commit -m "feat(gateway): resyncEntitlements 推 desired→容器→落 observed(不 bump/不滚 revision)"
```

---

## Task 4: enable 路由改调 resync(不 bump),disable 保留旧逻辑

**Files:**
- Modify: `apps/gateway/src/api/entitlements.ts`
- Test: `apps/gateway/test/api/entitlements.test.ts`

**Interfaces:**
- Consumes: `resyncEntitlements`、`syncUserContainer`(from `../provisioning/manager.js`);`dao.entitlements.{enable,disable,bumpTokenVersion,listActive}`。
- Produces: 路由行为不变的对外契约(`EntitlementChangeResponse = { ok, entitlements, changed }`,200)。内部:enable → `resyncEntitlements`(fire-and-forget,**不 bump**);disable → `bumpTokenVersion`(changed 时)+ `syncUserContainer`(fire-and-forget)。

- [ ] **Step 1: 先改测试到目标行为(改已有断言)**

编辑 `apps/gateway/test/api/entitlements.test.ts`:

1) 顶部把 manager mock 从只 mock `syncUserContainer` 改成同时 mock `resyncEntitlements`(替换第 13–14 行):

```ts
// enable 走 resyncEntitlements(轻量, 不 bump), disable 走 syncUserContainer(reconcile)。整体 mock, 只验触发。
const { syncUserContainer, resyncEntitlements } = vi.hoisted(() => ({
  syncUserContainer: vi.fn(async () => {}),
  resyncEntitlements: vi.fn(async () => {}),
}));
vi.mock('../../src/provisioning/manager.js', () => ({ syncUserContainer, resyncEntitlements }));
```

2) 替换 `describe('POST /api/entitlements/cloud/enable', …)` 整块为(enable 不再 bump、走 resync):

```ts
describe('POST /api/entitlements/cloud/enable', () => {
  it('happy path: enable changes state → NO bump → resync (no revision roll)', async () => {
    vi.mocked(dao.entitlements.enable).mockResolvedValue({ changed: true });
    vi.mocked(dao.entitlements.listActive).mockResolvedValue(['cloud']);

    const res = await request(makeApp()).post('/api/entitlements/cloud/enable');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, entitlements: ['cloud'], changed: true });
    expect(dao.entitlements.enable).toHaveBeenCalledWith(USER_ID, 'cloud');
    expect(dao.entitlements.bumpTokenVersion).not.toHaveBeenCalled();
    expect(resyncEntitlements).toHaveBeenCalledWith(USER_ID);
    expect(syncUserContainer).not.toHaveBeenCalled();
  });

  it('idempotent: already enabled → still resync (declarative, harmless)', async () => {
    vi.mocked(dao.entitlements.enable).mockResolvedValue({ changed: false });
    vi.mocked(dao.entitlements.listActive).mockResolvedValue(['cloud']);

    const res = await request(makeApp()).post('/api/entitlements/cloud/enable');

    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    expect(dao.entitlements.bumpTokenVersion).not.toHaveBeenCalled();
    expect(resyncEntitlements).toHaveBeenCalledWith(USER_ID);
  });
});
```

3) 替换 `describe('POST /api/entitlements/cloud/disable', …)` 整块为(disable 不动:bump + syncUserContainer):

```ts
describe('POST /api/entitlements/cloud/disable', () => {
  it('disable changes state → bump version → syncUserContainer (reconcile), no blob delete', async () => {
    vi.mocked(dao.entitlements.disable).mockResolvedValue({ changed: true });
    vi.mocked(dao.entitlements.listActive).mockResolvedValue([]);
    vi.mocked(dao.entitlements.bumpTokenVersion).mockResolvedValue(2);

    const res = await request(makeApp()).post('/api/entitlements/cloud/disable');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, entitlements: [], changed: true });
    expect(dao.entitlements.disable).toHaveBeenCalledWith(USER_ID, 'cloud');
    expect(dao.entitlements.bumpTokenVersion).toHaveBeenCalled();
    expect(syncUserContainer).toHaveBeenCalledWith(USER_ID);
    expect(resyncEntitlements).not.toHaveBeenCalled();
  });
});
```

4) `describe('feature allowlist', …)` 里 unknown-feature 用例的 `syncUserContainer` 断言保留(enable 路径未到 sync 层),并补一条 resync 未触发:

```ts
  it('unknown feature → 404, no DAO call', async () => {
    const res = await request(makeApp()).post('/api/entitlements/bogus/enable');
    expect(res.status).toBe(404);
    expect(dao.entitlements.enable).not.toHaveBeenCalled();
    expect(resyncEntitlements).not.toHaveBeenCalled();
  });
```

(`email is now allowed` 与 `onEnable hook` 两块去掉对 `bumpTokenVersion` 的 mock 行即可——它们只断言 enable/onEnable 被调,不依赖 bump;保留 `listActive` mock。)

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/gateway && pnpm vitest run test/api/entitlements.test.ts`
Expected: FAIL —— 现实现 enable 仍 bump + 调 syncUserContainer,新断言不满足。

- [ ] **Step 3: 改实现 —— 拆 enable / disable 两个 handler**

替换 `apps/gateway/src/api/entitlements.ts` 第 9 行 import + 第 20–57 行(`makeHandler` 工厂 + 两条 router.post)为:

```ts
import { syncUserContainer, resyncEntitlements } from '../provisioning/manager.js';
```

```ts
  // enable: 纯加法, 不 bump token_version; 轻量 resync 推 desired 给热容器建软链 + 回报 observed (不滚 revision)。
  const enableHandler: RequestHandler = async (req: Request, res: Response) => {
    const feature = req.params['feature'] as string;
    if (!ALLOWED_FEATURES.has(feature)) {
      res.status(404).json({ error: `unknown feature: ${feature}` });
      return;
    }
    const userId = req.session!.user_id;
    try {
      const { changed } = await dao.entitlements.enable(userId, feature);
      if (deps.onEnable) {
        try {
          await deps.onEnable(userId, feature);
        } catch (err) {
          console.error(`[entitlements] onEnable hook failed for ${userId}/${feature}:`, err);
        }
      }
      // fire-and-forget: resync 在热容器上 ~1-2s 完成, 前端轮询 /api/status 看 observed 翻转。
      // 冷容器 / resync 失败时 desired 已落库, 容器 bootstrap 的 sync-entitlements 会自然收敛 (安全网)。
      void resyncEntitlements(userId).catch((err) =>
        console.error(`[entitlements] resync failed for ${userId}:`, err),
      );
      const active = await dao.entitlements.listActive(userId);
      const body: EntitlementChangeResponse = { ok: true, entitlements: active, changed };
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: 'internal', message: String(err) });
    }
  };

  // disable: 保留旧逻辑 —— bump token_version (顺带真吊销旧 token) + syncUserContainer (滚 revision 重投)。
  const disableHandler: RequestHandler = async (req: Request, res: Response) => {
    const feature = req.params['feature'] as string;
    if (!ALLOWED_FEATURES.has(feature)) {
      res.status(404).json({ error: `unknown feature: ${feature}` });
      return;
    }
    const userId = req.session!.user_id;
    try {
      const { changed } = await dao.entitlements.disable(userId, feature);
      if (changed) {
        await dao.entitlements.bumpTokenVersion(userId);
      }
      void syncUserContainer(userId).catch((err) =>
        console.error(`[entitlements] syncUserContainer failed for ${userId}:`, err),
      );
      const active = await dao.entitlements.listActive(userId);
      const body: EntitlementChangeResponse = { ok: true, entitlements: active, changed };
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: 'internal', message: String(err) });
    }
  };

  router.post('/api/entitlements/:feature/enable', deps.sessionMw, enableHandler);
  router.post('/api/entitlements/:feature/disable', deps.sessionMw, disableHandler);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/gateway && pnpm vitest run test/api/entitlements.test.ts test/provisioning/resync.test.ts`
Expected: PASS。

- [ ] **Step 5: Gateway 全量回归**

Run: `cd apps/gateway && pnpm test`
Expected: 全绿(尤其 `provisioning/*`、`api/*` 不回归)。

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/api/entitlements.ts apps/gateway/test/api/entitlements.test.ts
git commit -m "feat(gateway): enable 走轻量 resync(不 bump);disable 保留 bump+reconcile"
```

---

## Task 5: 前端等待弹窗 block + 180s 超时 + 文案

**Files:**
- Modify: `apps/web/src/apps/manage/BuyCloudButton.tsx`
- Modify: `apps/web/src/apps/manage/CapabilityAction.tsx`
- Test: `apps/web/test/BuyCloudButton.test.tsx`

**Interfaces:**
- Consumes: `entitlementsAtom`(`ent.observed`)、`api.enableCloud` / `api.enableFeature`(已存在)。
- Produces: 装备等待时长常量 `EQUIP_TIMEOUT_MS = 180_000`;polling/timeout 文案改实。弹窗本就是 `position:fixed inset:0` 的 modal(block 当前界面),保持不变。

注:`CapabilityRemove`(退订)不在本期范围 —— `CapabilityAction.tsx` 里它用的 `POLL_TIMEOUT_MS`(30s)**保持不变**,只改 `CapabilityEquip`。

- [ ] **Step 1: 写失败测试**

Create `apps/web/test/BuyCloudButton.test.tsx`(镜像 `DisableCloudButton.test.tsx` 的 fake-timer 套路):

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { BuyCloudButton } from '../src/apps/manage/BuyCloudButton.js';
import { WithStore } from '../src/atom/index.js';

vi.mock('../src/lib/api.js', () => ({
  enableCloud: vi.fn(),
  status: vi.fn(),
  AuthError: class extends Error {},
}));
import * as api from '../src/lib/api.js';

const statusWith = (observed: string[]) => ({
  status: 'ready' as const, provisioning_step: null, progress_pct: 100, error_message: null,
  entitlements_desired: observed, entitlements_observed: observed, container_token_version: 1,
});

describe('BuyCloudButton', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.enableCloud).mockReset();
    vi.mocked(api.status).mockResolvedValue(statusWith([]));
  });
  afterEach(() => { vi.useRealTimers(); });

  it('confirm → polling shows blocking copy → observed flips → ✓ 已装备', async () => {
    vi.mocked(api.enableCloud).mockResolvedValue({ ok: true, entitlements: ['cloud'], changed: true });
    vi.mocked(api.status)
      .mockResolvedValueOnce(statusWith([]))
      .mockResolvedValue(statusWith(['cloud']));

    render(<WithStore><BuyCloudButton onReady={() => {}} /></WithStore>);
    fireEvent.click(screen.getByText('购买并装备'));
    await waitFor(() => expect(screen.getByText('确认购买并装备')).toBeInTheDocument());
    fireEvent.click(screen.getByText('确认购买并装备'));

    await waitFor(() => expect(screen.getByText(/正在装备到助理/)).toBeInTheDocument());
    expect(screen.getByText(/约需 1 分钟/)).toBeInTheDocument();

    for (let i = 0; i < 3; i++) { await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); }
    await waitFor(() => expect(screen.getByText('✓ 已装备')).toBeInTheDocument());
  });

  it('observed never flips → after 180s shows 装备失败 + 重试 (not before)', async () => {
    vi.mocked(api.enableCloud).mockResolvedValue({ ok: true, entitlements: ['cloud'], changed: true });
    vi.mocked(api.status).mockResolvedValue(statusWith([])); // never flips

    render(<WithStore><BuyCloudButton onReady={() => {}} /></WithStore>);
    fireEvent.click(screen.getByText('购买并装备'));
    await waitFor(() => expect(screen.getByText('确认购买并装备')).toBeInTheDocument());
    fireEvent.click(screen.getByText('确认购买并装备'));
    await waitFor(() => expect(screen.getByText(/正在装备到助理/)).toBeInTheDocument());

    // 30s 时仍在装备 (旧的 30s 判死已删)
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.queryByText(/装备失败/)).not.toBeInTheDocument();

    // 跨过 180s → 失败
    await act(async () => { await vi.advanceTimersByTimeAsync(151_000); });
    await waitFor(() => expect(screen.getByText(/装备失败/)).toBeInTheDocument());
    expect(screen.getByText('立即重试')).toBeInTheDocument();
  });

  it('enableCloud throws → 购买失败', async () => {
    vi.mocked(api.enableCloud).mockRejectedValue(new Error('网络炸了'));
    render(<WithStore><BuyCloudButton onReady={() => {}} /></WithStore>);
    fireEvent.click(screen.getByText('购买并装备'));
    await waitFor(() => expect(screen.getByText('确认购买并装备')).toBeInTheDocument());
    fireEvent.click(screen.getByText('确认购买并装备'));
    await waitFor(() => expect(screen.getByText('购买失败')).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && pnpm vitest run test/BuyCloudButton.test.tsx`
Expected: FAIL —— 当前文案是"预计 5 - 15 秒"且 30s 即超时,`约需 1 分钟` / 180s 断言不满足。

- [ ] **Step 3: 改 `BuyCloudButton.tsx`**

把第 7–8 行:

```tsx
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 30_000;
```

改为:

```tsx
const POLL_INTERVAL_MS = 2000;
// 装备点亮 observed 要等容器建软链(热 ~1-2s; 冷启动最坏 ~1min)。放宽到 180s 兜底, 到点才判失败。
const EQUIP_TIMEOUT_MS = 180_000;
```

把 `handleEnable` 里 `POLL_TIMEOUT_MS` 改成 `EQUIP_TIMEOUT_MS`(第 40–43 行的 `setTimeout(...)` 用 `EQUIP_TIMEOUT_MS`)。

把 polling 文案块(第 98–103 行)替换为:

```tsx
            {phase === 'polling' && (
              <>
                <div style={{ fontWeight: 600 }}>正在装备到助理…</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                  冷启动时助理上线约需 1 分钟,请稍候
                </div>
              </>
            )}
```

把 timeout 文案块(第 114–125 行)替换为:

```tsx
            {phase === 'timeout' && (
              <>
                <div style={{ fontWeight: 600, color: 'var(--err, #c00)' }}>装备失败</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                  助理迟迟没有上线,请重试
                </div>
                <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'center' }}>
                  <button className="btn" onClick={() => setPhase('idle')}>关闭</button>
                  <button className="btn btn-primary" onClick={() => void handleEnable()}>立即重试</button>
                </div>
              </>
            )}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && pnpm vitest run test/BuyCloudButton.test.tsx`
Expected: PASS(3 个 it 全绿)。

- [ ] **Step 5: `CapabilityAction.tsx` 的 `CapabilityEquip` 同步改造**

`CapabilityEquip` 与 `BuyCloudButton` 是同一状态机(`api.enableFeature(cap.id)`)。`CapabilityRemove` 不动。

在第 7–8 行的两个常量之间新增装备专用超时:

```tsx
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 30_000;            // CapabilityRemove(退订)仍用 30s, 本期不动
const EQUIP_TIMEOUT_MS = 180_000;          // CapabilityEquip(装备)放宽到 180s
```

`CapabilityEquip.handleEnable` 里 `setTimeout` 用的 `POLL_TIMEOUT_MS` 改成 `EQUIP_TIMEOUT_MS`(第 52 行)。**注意**只改 `CapabilityEquip`,不要动 `CapabilityRemove.handleDisable`(第 159 行仍 `POLL_TIMEOUT_MS`)。

`CapabilityEquip` 的 polling 文案(第 95–100 行)替换为:

```tsx
          {phase === 'polling' && (
            <>
              <div style={{ fontWeight: 600 }}>正在装备到助理…</div>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>冷启动时助理上线约需 1 分钟,请稍候</div>
            </>
          )}
```

`CapabilityEquip` 的 timeout 文案(第 111–120 行)替换为:

```tsx
          {phase === 'timeout' && (
            <>
              <div style={{ fontWeight: 600, color: 'var(--err, #c00)' }}>装备失败</div>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>助理迟迟没有上线,请重试</div>
              <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'center' }}>
                <button className="btn" onClick={() => setPhase('idle')}>关闭</button>
                <button className="btn btn-primary" onClick={() => void handleEnable()}>立即重试</button>
              </div>
            </>
          )}
```

- [ ] **Step 6: 前端回归(test + build,不用 lint —— web lint baseline 本就红)**

Run: `cd apps/web && pnpm test && pnpm build`
Expected: vitest 全绿 + vite build 成功(尤其 `CapabilityAction.tsx` / `BuyCloudButton.tsx` 无 TS 报错)。

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/apps/manage/BuyCloudButton.tsx apps/web/src/apps/manage/CapabilityAction.tsx apps/web/test/BuyCloudButton.test.tsx
git commit -m "feat(web): 装备等待 block 弹窗 180s 超时 + 文案改实(消灭假失败)"
```

---

## 收尾:全工程冒烟(必做,smoke-test-before-done)

> 单测绿 ≠ 能启动。合并前按 memory `smoke-test-before-done` 真跑一遍。

- [ ] **Step 1: 全工程 build**

Run: `pnpm build`
Expected: 全 package 通过。

- [ ] **Step 2: 本地起栈冒烟(PROVISIONER=local)**

Run: `pnpm dev`(另开终端先 `pnpm dev:check`)
手测:登录 → 管理页点「购买并装备」邮件/云盘 → 弹窗 block 显示"正在装备到助理…" → 本地 docker hermes 容器收到 `POST /internal/resync-entitlements`(看 gateway 日志 `aca.*` / 容器日志 `linked skill`)→ observed 翻转 → 「✓ 已装备」。确认**无 token_version bump、无容器重启**。

- [ ] **Step 3: 完成分支收尾**

REQUIRED SUB-SKILL: 用 superpowers:finishing-a-development-branch 决定 merge / PR。**部署(gateway 重发 + Hermes 镜像 rebuild + 滚用户容器)须先获用户明示同意**(红线 + 部署注意见 spec §6)。

---

## Self-Review(已核对)

- **Spec 覆盖**:§4.1 容器纯函数 → Task 1;§4.1 新端点 → Task 2;§4.2 gateway `resyncEntitlements`(observed 落库 + setPolicyHash + 不 bump)→ Task 3;§4.2 enable 改 resync / disable 保留 → Task 4;§4.3 token 不 bump → Task 3+4(实现 + 断言);§4.4 前端 block + 180s + 文案 → Task 5;§4.5 安全网(desired 已落库 + 幂等)→ Task 1 幂等测 + Task 3 早退分支 + Task 4 注释;§5 三层测试 → 各 Task 的 test;§6 部署 → 收尾 Step 3(只提示,不执行)。disable 轻量化、聊天慢 = spec 非目标,未排任务 ✅。
- **类型一致**:`applyEntitlements(desired, skillsDir?, sourceDir?) → string[]` 在 Task 1 定义、Task 2 消费一致;`handleResyncEntitlements(req, apply?)` Task 2 内自洽;`resyncEntitlements(userId) → Promise<void>` Task 3 定义、Task 4 消费一致;请求体 `{entitlements, token_version}` / 响应体 `{observed, token_version}` 两侧(Task 2 容器、Task 3 gateway)字段名匹配。
- **Placeholder 扫描**:无 TODO / "add error handling" 类占位,每步含完整代码或精确命令 + 期望输出。
