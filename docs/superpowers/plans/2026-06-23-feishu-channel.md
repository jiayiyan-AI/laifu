# 飞书渠道 (Feishu Channel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增"飞书"对话渠道——用户在 laifu 网页扫码建自建飞书 app（+管理员审批），即可在飞书私聊里和自己的 Hermes 实例文本收发，完全对标已有的微信 iLink 渠道。

**Architecture:** 移植 openclaw 的 device-code 扫码建应用 + `@larksuiteoapi/node-sdk` WSClient 长连接。每用户 1 自建 app（凭证存 DB），`FeishuConnectionManager` 每个 active binding 持一条 WS（对标微信 `PollManager`）。入站事件经 `dispatchHermesChat({source:'feishu'})` 走与微信完全相同的异步回调链（`/internal/hermes-callback` → `feishuReplier` 发回飞书），天然绕开 ACA ingress 超时。

**Tech Stack:** TypeScript / Node 22 / Express / Drizzle(Postgres) / `@larksuiteoapi/node-sdk@^1.60.0` / Vitest。

**关键决策（已拍板）:**
- `app_secret` **明文存 DB**，对齐微信 `wechat_bindings.bot_token`（MVP，spec §9.1）。
- 搭便车复用 openclaw 飞书专属端点（`oc_onboard` onboarding + `openclaw_bot/ping`），产品已确认（spec §2）。
- 只做 WebSocket 收 + `im.message.create` 发，单用户私聊文本（spec §3 非目标）。

**参照源:**
- 内部模板：`apps/gateway/src/wechat-ilink/`、`apps/gateway/src/db/wechat-binding-dao.ts`、`apps/gateway/src/api/wechat-bind.ts`、`apps/gateway/src/api/internal-callback.ts`、`apps/gateway/src/index.ts`
- openclaw 移植源：`/Users/yanjiayi/workspace/openclaw/extensions/feishu/src/{app-registration,client,probe,async}.ts`
- 设计：`docs/superpowers/specs/2026-06-22-feishu-channel-design.md`

---

## 文件结构 (File Structure)

**新建:**
| 文件 | 职责 |
|---|---|
| `apps/gateway/src/feishu/registration.ts` | 移植 openclaw app-registration：device-code 扫码建 app（init/begin/poll/ownerOpenId），去 openclaw 内部耦合 |
| `apps/gateway/src/feishu/client.ts` | 移植 openclaw client：`createFeishuClient`(Lark.Client) / `createFeishuWSClient`(Lark.WSClient) / `sendFeishuMessage`(im.message.create) |
| `apps/gateway/src/feishu/probe.ts` | 移植 openclaw probe：`openclaw_bot/ping` 验活，取 bot open_id |
| `apps/gateway/src/feishu/async.ts` | 直接复制 openclaw async.ts（`raceWithTimeoutAndAbort`，纯 JS 无依赖） |
| `apps/gateway/src/feishu/connection-manager.ts` | `FeishuConnectionManager`：对标 PollManager，每 binding 一条 WS |
| `apps/gateway/src/feishu/inbound-handler.ts` | `makeFeishuInbound` 工厂 + `feishuReplyContexts` Map：解析 `im.message.receive_v1`、open_id 鉴权、去重、dispatch |
| `apps/gateway/src/db/feishu-binding-dao.ts` | `feishu_bindings` DAO，对标 wechat-binding-dao |
| `apps/gateway/src/api/feishu-bind.ts` | 绑定路由：scan-start / scan-poll / activate / unbind |
| `apps/web/src/states/useFeishuBind.ts` | 前端绑定状态机（扫码→pending_approval→activate） |
| `apps/gateway/test/feishu/*.test.ts` | 单测，镜像 `test/wechat-ilink/` |

**修改:**
| 文件 | 改动 |
|---|---|
| `packages/db/src/schema.ts` | 新增 `feishuBindings` 表；`messageSourceEnum` 加 `'feishu'`；`threads.source` 注释 |
| `apps/gateway/src/db/index.ts` | `Dao` interface + `factories` 注册 `feishuBindings` |
| `apps/gateway/src/api/internal-callback.ts` | `CallbackRouterDeps` 加 `feishuReplier?`；`source` 类型加 `'feishu'`；feishu 回复分支 |
| `apps/gateway/src/index.ts` | 构造 `FeishuConnectionManager` + startAll/stopAll；`CreateAppOptions.feishuMgr?`；条件挂 `buildFeishuBindRouter`；定义 `feishuReplier` 传入 callback router |
| `apps/gateway/src/config.ts` + `apps/gateway/.env.example` + `infra/bicep/main.bicep` | 加 `FEISHU_ENABLED`(默认 off) + `FEISHU_DOMAIN`(默认 `feishu`) |
| `packages/shared/src/contracts.ts` | 飞书绑定契约（FeishuScanStart/Poll/Activate/Binding 响应） |
| `apps/web/src/lib/api.ts` | 飞书绑定 API 调用 |
| `apps/web/src/apps/im/providers.tsx` | 接通飞书 provider 的绑定动作 |
| `apps/gateway/package.json` | `@larksuiteoapi/node-sdk` 依赖 |

---

## Phase 1 — 数据层

### Task 1: 加依赖 `@larksuiteoapi/node-sdk`

**Files:** Modify `apps/gateway/package.json`

- [ ] **Step 1: 安装（对齐 openclaw 版本）**

Run: `cd /Users/yanjiayi/workspace/laifu/apps/gateway && pnpm add @larksuiteoapi/node-sdk@^1.60.0`

- [ ] **Step 2: 验证装上**

Run: `cd /Users/yanjiayi/workspace/laifu && node -e "require('@larksuiteoapi/node-sdk'); console.log('ok')"`
Expected: 打印 `ok`，无报错。

- [ ] **Step 3: 冒烟——确认能进 vite lib 单文件打包（spec §9.4 风险点）**

Run: `cd /Users/yanjiayi/workspace/laifu && pnpm --filter @lingxi/gateway build 2>&1 | tail -5`
Expected: `Done`，无 "cannot bundle / external" 报错。若 SDK 报无法打包，记录到 plan 末「执行笔记」，可能需 vite `ssr.noExternal` 配置。

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/package.json pnpm-lock.yaml
git commit -m "chore(feishu): 引入 @larksuiteoapi/node-sdk"
```

---

### Task 2: schema 加 `feishu_bindings` 表 + enum 扩 `'feishu'`

**Files:** Modify `packages/db/src/schema.ts`（`wechat_bindings` 在 75-88；`messageSourceEnum` 在 202；`threads.source` 注释在 66）

- [ ] **Step 1: 在 wechat_bindings 表后新增 feishu_bindings**

在 `wechatBindings` 定义之后插入（对标 wechat，列见 spec §7；`app_secret` 明存）：

```ts
// ── feishu_bindings ─────────────────────────────────────────────────────
// 每用户 1 自建飞书 app（owner=该用户）。app_secret 明存，对齐 wechat_bindings.bot_token。
export const feishuBindings = pgTable('feishu_bindings', {
  id:            uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  user_id:       uuid('user_id').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
  app_id:        text('app_id').notNull().unique(),
  app_secret:    text('app_secret').notNull(),
  domain:        text('domain').notNull().default('feishu'),   // 'feishu' | 'lark'
  owner_open_id: text('owner_open_id').notNull(),              // 扫码者 = 唯一允许的发信人
  thread_id:     text('thread_id').references(() => threads.id, { onDelete: 'set null' }),
  status:        text('status').notNull().default('pending_approval'), // 'pending_approval' | 'active'
  is_active:     boolean('is_active').notNull().default(true),
  bound_at:      timestamp('bound_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_feishu_bindings_active').on(t.is_active).where(sql`is_active = true`),
]);
```

- [ ] **Step 2: enum 加 'feishu'**

把 `messageSourceEnum`（行 202）改为：
```ts
export const messageSourceEnum = pgEnum('message_source', ['web', 'wechat', 'feishu']);
```
把 `threads.source` 注释（行 66）改为：`// 'web' | 'wechat' | 'feishu'`

- [ ] **Step 3: 生成迁移**

Run: `cd /Users/yanjiayi/workspace/laifu && pnpm db:generate`
Expected: 在 `packages/db/drizzle/` 生成新迁移（含 `create table feishu_bindings` + `alter type message_source add value 'feishu'`）。检查生成的 SQL 文件内容无误。

- [ ] **Step 4: 跑迁移到本地 dev DB 验证可执行**

Run: `cd /Users/yanjiayi/workspace/laifu && pnpm db:migrate 2>&1 | tail -5`
Expected: 迁移成功；`docker exec lingxi-pg-dev psql -U postgres -d postgres -c "\d feishu_bindings"` 能看到表。

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle/
git commit -m "feat(db): feishu_bindings 表 + message_source 加 feishu"
```

---

### Task 3: `feishu-binding-dao.ts`（TDD）

**Files:** Create `apps/gateway/src/db/feishu-binding-dao.ts`；Test `apps/gateway/test/db/feishu-binding-dao.test.ts`；参照 `apps/gateway/src/db/wechat-binding-dao.ts`

- [ ] **Step 1: 写失败测试**

镜像 `test/db/` 既有 DAO 测试风格（用 `mockDrizzleDb` helper，参考 `test/db/email-dao.test.ts`）。覆盖：`upsertByUserId` 走 onConflictDoUpdate(user_id)；`listActive` 过滤 is_active；`setActive`/`bindThread`/`deactivate` 调对的 update。

```ts
import { describe, it, expect, vi } from 'vitest';
import { makeFeishuBindingDao } from '../../src/db/feishu-binding-dao.js';
import { mockDrizzleDb } from '../helpers/mock-drizzle.js';   // 复用 email-dao.test.ts 同款 helper

describe('feishu-binding-dao', () => {
  it('upsertByUserId 按 user_id onConflictDoUpdate', async () => {
    const { db, calls } = mockDrizzleDb({ returning: [{ id: 'b1' }] });
    const dao = makeFeishuBindingDao(db);
    await dao.upsertByUserId({ userId: 'u1', appId: 'a', appSecret: 's', domain: 'feishu', ownerOpenId: 'o' });
    expect(calls.onConflictDoUpdate).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/gateway && pnpm exec vitest run test/db/feishu-binding-dao.test.ts`
Expected: FAIL（`makeFeishuBindingDao` 未定义）。

- [ ] **Step 3: 实现 DAO（对标 wechat-binding-dao 6 方法）**

```ts
import type { Db } from '@lingxi/db';
import { schema } from '@lingxi/db';
import { eq } from 'drizzle-orm';

export interface FeishuBinding {
  id: string;
  user_id: string;
  app_id: string;
  app_secret: string;
  domain: string;
  owner_open_id: string;
  thread_id: string | null;
  status: string;
  is_active: boolean;
  bound_at: string;
}

export interface FeishuBindingDao {
  listActive(): Promise<FeishuBinding[]>;
  getByUserId(userId: string): Promise<FeishuBinding | null>;
  upsertByUserId(a: { userId: string; appId: string; appSecret: string; domain: string; ownerOpenId: string }): Promise<FeishuBinding>;
  setActive(id: string, status: string): Promise<void>;   // 置 active + status
  bindThread(id: string, threadId: string): Promise<void>;
  deactivate(id: string): Promise<void>;
}

export const makeFeishuBindingDao = (db: Db): FeishuBindingDao => {
  const f = schema.feishuBindings;
  return {
    async listActive() {
      return db.select().from(f).where(eq(f.is_active, true)) as Promise<FeishuBinding[]>;
    },
    async getByUserId(userId) {
      const rows = await db.select().from(f).where(eq(f.user_id, userId)).limit(1);
      return (rows[0] ?? null) as FeishuBinding | null;
    },
    async upsertByUserId({ userId, appId, appSecret, domain, ownerOpenId }) {
      const rows = await db.insert(f).values({
        user_id: userId, app_id: appId, app_secret: appSecret, domain,
        owner_open_id: ownerOpenId, status: 'pending_approval', is_active: true,
      }).onConflictDoUpdate({
        target: f.user_id,
        set: { app_id: appId, app_secret: appSecret, domain, owner_open_id: ownerOpenId, status: 'pending_approval', is_active: true },
      }).returning();
      return rows[0] as FeishuBinding;
    },
    async setActive(id, status) {
      await db.update(f).set({ is_active: true, status }).where(eq(f.id, id));
    },
    async bindThread(id, threadId) {
      await db.update(f).set({ thread_id: threadId }).where(eq(f.id, id));
    },
    async deactivate(id) {
      await db.update(f).set({ is_active: false }).where(eq(f.id, id));
    },
  };
};
```

- [ ] **Step 4: 跑测试通过**

Run: `cd apps/gateway && pnpm exec vitest run test/db/feishu-binding-dao.test.ts`
Expected: PASS。

- [ ] **Step 5: 在 db/index.ts 的 Proxy 工厂注册**

`apps/gateway/src/db/index.ts`：import `makeFeishuBindingDao, type FeishuBindingDao`；`Dao` interface 加 `feishuBindings: FeishuBindingDao;`；`factories` 加 `feishuBindings: () => makeFeishuBindingDao(getDb()),`（紧挨 `wechatBindings` 那行）。

- [ ] **Step 6: build + commit**

Run: `cd /Users/yanjiayi/workspace/laifu && pnpm --filter @lingxi/gateway build 2>&1 | tail -3`
```bash
git add apps/gateway/src/db/feishu-binding-dao.ts apps/gateway/src/db/index.ts apps/gateway/test/db/feishu-binding-dao.test.ts
git commit -m "feat(feishu): feishu_bindings DAO + 注册到 dao 工厂"
```

---

## Phase 2 — 移植层（从 openclaw 搬，去内部耦合）

> 移植原则：从 openclaw 源文件**复制**后施加下列**精确改写**，使其成为零 openclaw 依赖的独立模块。每个 task 列出必须保留的导出签名与必须替换的耦合点。不要重写逻辑，只去耦合。

### Task 4: `feishu/async.ts`（直接复制）

**Files:** Create `apps/gateway/src/feishu/async.ts`（源 `openclaw/extensions/feishu/src/async.ts`，纯 JS 无依赖）

- [ ] **Step 1: 复制**

Run: `mkdir -p apps/gateway/src/feishu && cp /Users/yanjiayi/workspace/openclaw/extensions/feishu/src/async.ts apps/gateway/src/feishu/async.ts`

- [ ] **Step 2: 确认零内部 import**

Run: `grep -nE "^import|from ['\"]\.\./|plugin-sdk" apps/gateway/src/feishu/async.ts`
Expected: 无 `plugin-sdk` / 无跨包相对 import（digest 已确认完全独立）。若有残留，删除并内联。导出须含 `raceWithTimeoutAndAbort`。

- [ ] **Step 3: build + commit**

```bash
git add apps/gateway/src/feishu/async.ts
git commit -m "feat(feishu): 移植 async 工具(raceWithTimeoutAndAbort)"
```

---

### Task 5: `feishu/registration.ts`（移植 device-code 建应用）

**Files:** Create `apps/gateway/src/feishu/registration.ts`（源 `openclaw/.../app-registration.ts`）；Test `apps/gateway/test/feishu/registration.test.ts`

- [ ] **Step 1: 复制并施加去耦合改写**

复制源文件到目标路径，然后做以下**精确替换**：
1. 删 `printQrCode` 函数及其 `qrcode-terminal` import（我们把 `qrUrl` 直接给前端渲染，不在终端打印）。
2. `fetchWithSsrFGuard(...)` → 全部替换为全局 `fetch(...)`（gateway 是受信进程，目标域是飞书固定域名，无 SSRF 面）。删其 import。
3. 顶部不引入任何 `openclaw/plugin-sdk/*`。
4. 在文件内联类型：`export type FeishuDomain = 'feishu' | 'lark';`
5. **保留**端点与请求体字段不变（spec §2 搭便车的关键）：`POST https://accounts.feishu.cn/oauth/v1/app/registration`，body `action:'init'|'begin'|'poll'`、`archetype:'PersonalAgent'`、`auth_method:'client_secret'`、`request_user_info:'open_id'`，QR 参数 `from=oc_onboard`、`tp=ob_cli_app`。

**必须导出的签名（保持与源一致）:**
```ts
export type FeishuDomain = 'feishu' | 'lark';
export interface AppRegistrationResult { appId: string; appSecret: string; domain: FeishuDomain; ownerOpenId?: string }
export function beginAppRegistration(domain?: FeishuDomain): Promise<{ deviceCode: string; qrUrl: string; userCode: string; interval: number; expireIn: number }>;
export function pollAppRegistration(p: { deviceCode: string; interval: number; expireIn: number; initialDomain?: FeishuDomain; abortSignal?: AbortSignal; tp?: string }): Promise<{ status: 'success' | 'access_denied' | 'expired' | 'timeout' | 'error'; result?: AppRegistrationResult; message?: string }>;
export function getAppOwnerOpenId(p: { appId: string; appSecret: string; domain?: FeishuDomain }): Promise<string | undefined>;
```
（`getAppOwnerOpenId` 用 tenant_access_token + `GET /open-apis/application/v6/applications/{appId}` 取 owner open_id；保留源逻辑。）

- [ ] **Step 2: 写失败测试（mock global fetch）**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { beginAppRegistration, pollAppRegistration } from '../../src/feishu/registration.js';

const mockFetch = (bodies: any[]) => {
  let i = 0;
  return vi.fn(async () => ({ ok: true, json: async () => bodies[Math.min(i++, bodies.length - 1)] }));
};

describe('feishu registration', () => {
  beforeEach(() => { vi.stubGlobal('fetch', mockFetch([])); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('begin 返回 deviceCode + qrUrl(含 from=oc_onboard)', async () => {
    vi.stubGlobal('fetch', mockFetch([
      { code: 0, data: {} },  // init
      { code: 0, data: { device_code: 'dc1', verification_uri_complete: 'https://applink.feishu.cn/x', interval: 5, expires_in: 300, user_code: 'U1' } },  // begin
    ]));
    const r = await beginAppRegistration('feishu');
    expect(r.deviceCode).toBe('dc1');
    expect(r.qrUrl).toContain('from=oc_onboard');
    expect(r.qrUrl).toContain('tp=ob_cli_app');
  });

  it('poll authorization_pending → 再 poll success 返回凭证', async () => {
    vi.stubGlobal('fetch', mockFetch([
      { code: 0, error: 'authorization_pending' },
      { code: 0, data: { client_id: 'cli_app123', client_secret: 'secret', user_info: { tenant_brand: 'feishu' } } },
    ]));
    const r = await pollAppRegistration({ deviceCode: 'dc1', interval: 0, expireIn: 300 });
    expect(r.status).toBe('success');
    expect(r.result?.appId).toBe('cli_app123');
    expect(r.result?.appSecret).toBe('secret');
  });
});
```
（注：测试里 `interval: 0` 避免真 sleep；若源用固定 setTimeout，在实现里把 sleep 时长设为 `interval*1000` 即可由测试控制。字段名以源实际返回为准，跑红后按源对齐。）

- [ ] **Step 3: 跑测试确认失败 → 调整实现到通过**

Run: `cd apps/gateway && pnpm exec vitest run test/feishu/registration.test.ts`
Expected: 先 FAIL（未导出），去耦合改写后 PASS。若字段名与 mock 不符，以**源文件实际字段**为准修正测试。

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/src/feishu/registration.ts apps/gateway/test/feishu/registration.test.ts
git commit -m "feat(feishu): 移植 device-code 扫码建应用(去 openclaw 耦合)"
```

---

### Task 6: `feishu/client.ts`（移植 Lark SDK 封装 + 发消息）

**Files:** Create `apps/gateway/src/feishu/client.ts`（源 `openclaw/.../client.ts`）；Test `apps/gateway/test/feishu/client.test.ts`

- [ ] **Step 1: 复制并去耦合**

复制后改写：
1. `readPluginPackageVersion(...)` → 硬编码 UA 版本串常量，如 `const FEISHU_UA = 'laifu-feishu/1';`（保留"覆盖默认 UA"的行为，spec §2 标识照搬非必需，UA 不影响建应用，可用我们自己的）。
2. `resolveAmbientNodeProxyAgent(...)` → 替换为读 `process.env.HTTPS_PROXY`/`undefined`（gateway 有 `lib/proxy-bootstrap.ts`，WS 代理用 env 即可；先返回 `undefined`，冒烟再按需接）。
3. 删所有 `openclaw/plugin-sdk/*` import。
4. 简化：删 config-schema 驱动的超时多来源逻辑，固定 `const HTTP_TIMEOUT_MS = 30_000;`。

**必须导出的签名:**
```ts
import * as Lark from '@larksuiteoapi/node-sdk';
export interface FeishuCreds { appId: string; appSecret: string; domain: 'feishu' | 'lark' }
export function createFeishuClient(c: FeishuCreds): Lark.Client;
export function createFeishuWSClient(c: FeishuCreds): Lark.WSClient;
/** im.message.create，receive_id_type=open_id，发纯文本。 */
export function sendFeishuMessage(client: Lark.Client, toOpenId: string, text: string): Promise<void>;
```

`sendFeishuMessage` 实现（飞书文本消息 content 是 JSON 字符串）：
```ts
export async function sendFeishuMessage(client: Lark.Client, toOpenId: string, text: string): Promise<void> {
  await client.im.message.create({
    params: { receive_id_type: 'open_id' },
    data: { receive_id: toOpenId, msg_type: 'text', content: JSON.stringify({ text }) },
  });
}
```
`createFeishuClient` 用 `new Lark.Client({ appId, appSecret, appType: Lark.AppType.SelfBuild, domain: domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu })`。
`createFeishuWSClient` 用 `new Lark.WSClient({ appId, appSecret, domain: ..., loggerLevel: Lark.LoggerLevel.info })`。

- [ ] **Step 2: 写失败测试（注入假 Lark.Client）**

```ts
import { describe, it, expect, vi } from 'vitest';
import { sendFeishuMessage } from '../../src/feishu/client.js';

describe('sendFeishuMessage', () => {
  it('调 im.message.create，open_id + text content', async () => {
    const create = vi.fn(async () => ({}));
    const fake = { im: { message: { create } } } as any;
    await sendFeishuMessage(fake, 'ou_owner', '你好');
    expect(create).toHaveBeenCalledWith({
      params: { receive_id_type: 'open_id' },
      data: { receive_id: 'ou_owner', msg_type: 'text', content: JSON.stringify({ text: '你好' }) },
    });
  });
});
```

- [ ] **Step 3: 跑测试 fail → 实现 → pass**

Run: `cd apps/gateway && pnpm exec vitest run test/feishu/client.test.ts`
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/src/feishu/client.ts apps/gateway/test/feishu/client.test.ts
git commit -m "feat(feishu): 移植 Lark SDK 封装(client/WSClient/sendMessage)"
```

---

### Task 7: `feishu/probe.ts`（移植验活探针）

**Files:** Create `apps/gateway/src/feishu/probe.ts`（源 `openclaw/.../probe.ts`）；Test `apps/gateway/test/feishu/probe.test.ts`

- [ ] **Step 1: 复制并去耦合**

改写：
1. `formatErrorMessage(e)` → `(e: unknown) => e instanceof Error ? e.message : String(e)` 内联。
2. `raceWithTimeoutAndAbort` 改从 `./async.js` import（Task 4 已移植）。
3. `createFeishuClient` 改从 `./client.js` import。
4. 删 openclaw `plugin-sdk/core` 的 `BaseProbeResult`，内联类型。
5. **保留**端点 `POST /open-apis/bot/v1/openclaw_bot/ping`，body `{ needBotInfo: true }`（spec §6.4 搭便车关键）。可删源里的 64 条缓存逻辑（activate 只调一次，不需缓存）。

**必须导出:**
```ts
export interface FeishuProbeResult { ok: boolean; botOpenId?: string; botName?: string; error?: string }
export function probeFeishu(creds: { appId: string; appSecret: string; domain: 'feishu' | 'lark' }): Promise<FeishuProbeResult>;
```

- [ ] **Step 2: 写失败测试（注入 client.request）**

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/feishu/client.js', () => ({
  createFeishuClient: () => ({ request: vi.fn(async () => ({ code: 0, data: { pingBotInfo: { botID: 'ou_bot', botName: 'b' } } })) }),
}));
import { probeFeishu } from '../../src/feishu/probe.js';

describe('probeFeishu', () => {
  it('ping 成功 → ok + botOpenId', async () => {
    const r = await probeFeishu({ appId: 'a', appSecret: 's', domain: 'feishu' });
    expect(r.ok).toBe(true);
    expect(r.botOpenId).toBe('ou_bot');
  });
});
```

- [ ] **Step 3: fail → 实现 → pass**

Run: `cd apps/gateway && pnpm exec vitest run test/feishu/probe.test.ts`
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/src/feishu/probe.ts apps/gateway/test/feishu/probe.test.ts
git commit -m "feat(feishu): 移植验活探针(openclaw_bot/ping)"
```

---

## Phase 3 — 运行时

### Task 8: `feishu/inbound-handler.ts`（TDD）

**Files:** Create `apps/gateway/src/feishu/inbound-handler.ts`；Test `apps/gateway/test/feishu/inbound-handler.test.ts`；参照 `apps/gateway/src/wechat-ilink/inbound-handler.ts`（去重 / dispatchHermesChat / replyContexts / HARD_DEADLINE_MS）

- [ ] **Step 1: 写失败测试**

覆盖三条核心路径：(a) sender open_id ≠ binding.owner_open_id → 忽略不 dispatch；(b) 合法消息 → dispatchHermesChat({source:'feishu'}) 被调 + reply ctx 入 `feishuReplyContexts`；(c) 同 message_id 二次 → 去重不重复 dispatch。

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const dispatchHermesChat = vi.fn(async () => ({ ok: true, status: 202 }));
vi.mock('../../src/lib/aca-call.js', () => ({ dispatchHermesChat }));
vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

import { makeFeishuInbound, feishuReplyContexts } from '../../src/feishu/inbound-handler.js';

const binding = { id: 'b1', user_id: 'u1', owner_open_id: 'ou_owner', thread_id: 'thr1', app_id: 'a', app_secret: 's', domain: 'feishu', status: 'active', is_active: true, bound_at: '' };
const evt = (openId: string, msgId: string, text: string) => ({
  message: { message_id: msgId, message_type: 'text', content: JSON.stringify({ text }) },
  sender: { sender_id: { open_id: openId } },
});

describe('feishu inbound', () => {
  beforeEach(() => { vi.clearAllMocks(); feishuReplyContexts.clear(); });

  it('非 owner 发信 → 忽略', async () => {
    const handle = makeFeishuInbound()(binding as any, { im: { message: { create: vi.fn() } } } as any);
    await handle(evt('ou_stranger', 'm1', 'hi'));
    expect(dispatchHermesChat).not.toHaveBeenCalled();
  });

  it('owner 发信 → dispatch + 存 reply ctx', async () => {
    const handle = makeFeishuInbound()(binding as any, {} as any);
    await handle(evt('ou_owner', 'm2', '你好'));
    expect(dispatchHermesChat).toHaveBeenCalledWith(expect.objectContaining({ source: 'feishu', userId: 'u1', threadId: 'thr1' }));
    expect([...feishuReplyContexts.values()][0].toOpenId).toBe('ou_owner');
  });

  it('同 message_id 二次 → 去重', async () => {
    const handle = makeFeishuInbound()(binding as any, {} as any);
    await handle(evt('ou_owner', 'm3', 'a'));
    await handle(evt('ou_owner', 'm3', 'a'));
    expect(dispatchHermesChat).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/gateway && pnpm exec vitest run test/feishu/inbound-handler.test.ts`
Expected: FAIL（未定义）。

- [ ] **Step 3: 实现**

```ts
import { randomUUID } from 'node:crypto';
import * as Lark from '@larksuiteoapi/node-sdk';
import { dispatchHermesChat } from '../lib/aca-call.js';
import { storePendingLoop, HARD_DEADLINE_MS } from '../lib/pending-loops.js';
import { dao } from '../db/index.js';
import { warmContainerUrl } from '../lib/container-warm-cache.js';   // 与 wechat 同源取 containerUrl，按 wechat-handler 实际函数名对齐
import type { FeishuBinding } from '../db/feishu-binding-dao.js';

/** loop_id → 回复飞书所需上下文（feishuReplier 消费）。 */
export const feishuReplyContexts = new Map<string, { toOpenId: string; client: Lark.Client }>();

const seenMessageIds = new Set<string>();   // 进程内去重（单进程足够；容器侧落库本身幂等）

type InboundFactory = (binding: FeishuBinding, client: Lark.Client) => (evt: unknown) => Promise<void>;

export const makeFeishuInbound = (): InboundFactory => (binding, client) => async (evt: unknown) => {
  const e = evt as { message?: { message_id?: string; message_type?: string; content?: string }; sender?: { sender_id?: { open_id?: string } } };
  const messageId = e.message?.message_id;
  const senderOpenId = e.sender?.sender_id?.open_id;
  if (!messageId || !senderOpenId) return;
  if (senderOpenId !== binding.owner_open_id) return;              // 鉴权：只服务本人
  if (seenMessageIds.has(messageId)) return;                       // 去重
  seenMessageIds.add(messageId);
  if (e.message?.message_type !== 'text') {                        // MVP 只文本
    await client.im.message.create({ params: { receive_id_type: 'open_id' }, data: { receive_id: senderOpenId, msg_type: 'text', content: JSON.stringify({ text: '当前仅支持文本消息。' }) } }).catch(() => {});
    return;
  }
  const text = (JSON.parse(e.message.content ?? '{}') as { text?: string }).text ?? '';
  if (!text.trim()) return;

  const threadId = binding.thread_id;
  if (!threadId) return;                                           // activate 时已建 thread
  const loopId = randomUUID();
  feishuReplyContexts.set(loopId, { toOpenId: senderOpenId, client });

  const containerUrl = await warmContainerUrl(binding.user_id);    // 按 wechat-handler 实际复用点对齐
  storePendingLoop(
    { loopId, threadId, userId: binding.user_id, source: 'feishu' },
    { hardDeadlineMs: HARD_DEADLINE_MS, onDeadline: async () => { feishuReplyContexts.delete(loopId); /* 标 loop fail，对齐 wechat */ } },
  );
  await dispatchHermesChat({ containerUrl, userId: binding.user_id, threadId, source: 'feishu', sessionId: `feishu:${threadId}`, message: text, loopId });
};
```
> 执行注意：`warmContainerUrl` / `storePendingLoop` 的**确切函数名与签名**以 `wechat-ilink/inbound-handler.ts` 实际用法为准（执行时打开对照），本步用法是占位骨架，跑测试时按真实签名修正。

- [ ] **Step 4: 跑测试通过**

Run: `cd apps/gateway && pnpm exec vitest run test/feishu/inbound-handler.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/feishu/inbound-handler.ts apps/gateway/test/feishu/inbound-handler.test.ts
git commit -m "feat(feishu): 入站处理(open_id 鉴权+去重+dispatch)"
```

---

### Task 9: `feishu/connection-manager.ts`（TDD）

**Files:** Create `apps/gateway/src/feishu/connection-manager.ts`；Test `apps/gateway/test/feishu/connection-manager.test.ts`；参照 `wechat-ilink/poll-manager.ts`

- [ ] **Step 1: 写失败测试（注入假 WSClient 工厂）**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});
import { dao } from '../../src/db/index.js';
import { FeishuConnectionManager } from '../../src/feishu/connection-manager.js';

const b = (id: string) => ({ id, user_id: 'u' + id, app_id: 'a', app_secret: 's', domain: 'feishu', owner_open_id: 'o', thread_id: 't', status: 'active', is_active: true, bound_at: '' });

describe('FeishuConnectionManager', () => {
  beforeEach(() => vi.clearAllMocks());

  it('startAll 为每条 active binding 起一条 WS', async () => {
    vi.mocked(dao.feishuBindings.listActive).mockResolvedValue([b('1'), b('2')] as any);
    const start = vi.fn();
    const mgr = new FeishuConnectionManager({ onMessageFor: () => async () => {}, wsFactory: () => ({ start } as any) });
    await mgr.startAll();
    expect(mgr.size()).toBe(2);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('startOne 幂等；stopOne 移除', async () => {
    const mgr = new FeishuConnectionManager({ onMessageFor: () => async () => {}, wsFactory: () => ({ start: vi.fn() } as any) });
    mgr.startOne(b('1') as any);
    mgr.startOne(b('1') as any);
    expect(mgr.size()).toBe(1);
    mgr.stopOne('1');
    expect(mgr.size()).toBe(0);
  });
});
```

- [ ] **Step 2: fail**

Run: `cd apps/gateway && pnpm exec vitest run test/feishu/connection-manager.test.ts` → FAIL。

- [ ] **Step 3: 实现**

```ts
import * as Lark from '@larksuiteoapi/node-sdk';
import { dao } from '../db/index.js';
import { createFeishuWSClient } from './client.js';
import type { FeishuBinding } from '../db/feishu-binding-dao.js';

type OnMessageFactory = (binding: FeishuBinding, client: Lark.Client) => (evt: unknown) => Promise<void>;

export interface FeishuConnManagerOpts {
  onMessageFor: OnMessageFactory;
  wsFactory?: (b: FeishuBinding) => Lark.WSClient;   // 测试注入
  clientFactory?: (b: FeishuBinding) => Lark.Client;
}

export class FeishuConnectionManager {
  private conns = new Map<string, Lark.WSClient>();
  constructor(private opts: FeishuConnManagerOpts) {}

  async startAll(): Promise<void> {
    const active = await dao.feishuBindings.listActive();
    for (const b of active) this.startOne(b);
  }

  startOne(binding: FeishuBinding): void {
    if (this.conns.has(binding.id)) return;            // 幂等
    const ws = this.opts.wsFactory ? this.opts.wsFactory(binding) : createFeishuWSClient(binding);
    const client = this.opts.clientFactory ? this.opts.clientFactory(binding) : createFeishuClientFor(binding);
    const handle = this.opts.onMessageFor(binding, client);
    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => { await handle(data); },
    });
    ws.start({ eventDispatcher: dispatcher });
    this.conns.set(binding.id, ws);
  }

  stopOne(bindingId: string): void {
    const ws = this.conns.get(bindingId);
    if (!ws) return;
    try { (ws as unknown as { stop?: () => void }).stop?.(); } catch { /* SDK 可能无 stop，GC 即可 */ }
    this.conns.delete(bindingId);
  }

  async stopAll(): Promise<void> { for (const id of [...this.conns.keys()]) this.stopOne(id); }
  size(): number { return this.conns.size; }
}
```
（`createFeishuClientFor` = `createFeishuClient(binding)` 的薄封装，放本文件或直接 inline。`EventDispatcher.register` 的事件键 `im.message.receive_v1` 以 SDK 实际 API 为准，执行时对照 `@larksuiteoapi/node-sdk` 类型修正。）

- [ ] **Step 4: pass**

Run: `cd apps/gateway && pnpm exec vitest run test/feishu/connection-manager.test.ts` → PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/feishu/connection-manager.ts apps/gateway/test/feishu/connection-manager.test.ts
git commit -m "feat(feishu): 连接管理器(每 binding 一条 WS)"
```

---

## Phase 4 — 回调接线

### Task 10: `internal-callback.ts` 加 feishu 分支

**Files:** Modify `apps/gateway/src/api/internal-callback.ts`（`CallbackRouterDeps` 19-23；`source` 类型 61/82；wechat 分支 135-143）；Test 复用/扩 `apps/gateway/test/api/internal-callback.test.ts`

- [ ] **Step 1: 写失败测试**

在既有 internal-callback 测试里加：source='feishu' 且有 reply 时，`feishuReplier(threadId, reply)` 被调一次。

```ts
it('source=feishu 且有 reply → 调 feishuReplier', async () => {
  const feishuReplier = vi.fn(async () => {});
  // ...构造 thread.source='feishu' 的 loop，POST result 回调...
  // expect(feishuReplier).toHaveBeenCalledWith('thr1', 'hello');
});
```

- [ ] **Step 2: fail → 实现**

`CallbackRouterDeps` 加 `feishuReplier?: (threadId: string, text: string) => Promise<void>;`；`source` 联合类型两处加 `'feishu'`；在 wechat 分支后加并列分支：
```ts
if (source === 'feishu' && result.reply && deps.feishuReplier) {
  deps.feishuReplier(threadId, result.reply).catch((err) => {
    log.warn({ event: 'callback.feishu.reply.failed', thread_id: threadId, err: err instanceof Error ? err.message : String(err) });
  });
}
```

- [ ] **Step 3: pass + commit**

Run: `cd apps/gateway && pnpm exec vitest run test/api/internal-callback.test.ts` → PASS。
```bash
git add apps/gateway/src/api/internal-callback.ts apps/gateway/test/api/internal-callback.test.ts
git commit -m "feat(feishu): internal-callback 加 feishu 回复分支"
```

---

### Task 11: `index.ts` 接线 connMgr + feishuReplier + 路由

**Files:** Modify `apps/gateway/src/index.ts`（对标 pollMgr：import 38-40 / 构造 260-263 / CreateAppOptions 43-49 / 挂路由 106-111 / wechatReplier 119-136 / stopAll 284）

- [ ] **Step 1: 接线（无独立单测，靠 build + 后续冒烟）**

1. import：`FeishuConnectionManager`、`makeFeishuInbound, feishuReplyContexts`、`buildFeishuBindRouter`（Task 12）、`sendFeishuMessage`。
2. `CreateAppOptions` 加 `feishuMgr?: FeishuConnectionManager;`。
3. `start()` 里（仅 `FEISHU_ENABLED` 时）构造 `const feishuMgr = new FeishuConnectionManager({ onMessageFor: makeFeishuInbound() }); await feishuMgr.startAll();` 并在 SIGTERM 处 `await feishuMgr.stopAll();`。
4. 条件挂路由：`if (opts.feishuMgr) app.use(buildFeishuBindRouter({ feishuMgr: opts.feishuMgr, sessionMw }));`
5. 定义 `feishuReplier`（对标 wechatReplier，遍历 `feishuReplyContexts` 按 loop→thread 匹配）：
```ts
const feishuReplier = async (threadId: string, text: string): Promise<void> => {
  for (const [loopId, ctx] of feishuReplyContexts) {
    const loop = await dao.agentLoops.getById(loopId);
    if (loop && loop.thread_id === threadId) {
      try { await sendFeishuMessage(ctx.client, ctx.toOpenId, text); }
      finally { feishuReplyContexts.delete(loopId); }
      return;
    }
  }
};
app.use(buildCallbackRouter({ containerAuth, wechatReplier, feishuReplier }));
```

- [ ] **Step 2: build 全绿**

Run: `cd /Users/yanjiayi/workspace/laifu && pnpm --filter @lingxi/gateway build 2>&1 | tail -3`
Expected: `Done`。

- [ ] **Step 3: Commit**

```bash
git add apps/gateway/src/index.ts
git commit -m "feat(feishu): index 接线 connMgr/feishuReplier/路由"
```

---

## Phase 5 — 绑定 API + 前端

### Task 12: 绑定路由 `feishu-bind.ts`（TDD）

**Files:** Create `apps/gateway/src/api/feishu-bind.ts`；Test `apps/gateway/test/api/feishu-bind.test.ts`；参照 `api/wechat-bind.ts`（4 endpoint + requireSession）

端点（spec §5.1）：
- `POST /api/feishu/bind/scan-start` → `beginAppRegistration(domain)` → `{ qrUrl, deviceCode, interval, expireIn }`
- `POST /api/feishu/bind/scan-poll` → `pollAppRegistration(...)`；success 时 `getAppOwnerOpenId` + `dao.feishuBindings.upsertByUserId(...)`（status=pending_approval），返回 `{ status:'approved', appId, adminConsoleUrl }`；pending 返回 `{ status:'pending' }`
- `POST /api/feishu/bind/activate` → `probeFeishu(creds)` 验活；建 thread(source='feishu') + `bindThread` + `setActive(id,'active')` + `feishuMgr.startOne(binding)`；返回 `{ ok:true }`
- `POST /api/feishu/bind/unbind` → `feishuMgr.stopOne(id)` + `deactivate(id)`
- `GET /api/feishu/bind` → 当前绑定状态（`{ bound:false }` | `{ bound:true, status, app_id }`）

- [ ] **Step 1: 写失败测试**（镜像 `wechat-bind` 测试：mock registration/probe 模块 + mockDao + requireSession cookie）。至少覆盖：scan-start 返回 qrUrl；scan-poll success 落 binding；activate 验活成功置 active + startOne 调用；未登录 401。

- [ ] **Step 2: fail → 实现路由** （结构对标 `wechat-bind.ts`；async handler **一律包 try/catch** 返 500，遵守 smoke-test 记忆）。

- [ ] **Step 3: pass**

Run: `cd apps/gateway && pnpm exec vitest run test/api/feishu-bind.test.ts` → PASS。

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/src/api/feishu-bind.ts apps/gateway/test/api/feishu-bind.test.ts
git commit -m "feat(feishu): 绑定路由(scan/activate/unbind)"
```

---

### Task 13: shared 契约 + web api 客户端

**Files:** Modify `packages/shared/src/contracts.ts`、`apps/web/src/lib/api.ts`

- [ ] **Step 1: 契约**

`contracts.ts` 加（与路由返回对齐）：
```ts
export interface FeishuScanStartResponse { qrUrl: string; deviceCode: string; interval: number; expireIn: number }
export type FeishuScanPollResponse =
  | { status: 'pending' }
  | { status: 'approved'; appId: string; adminConsoleUrl: string }
  | { status: 'denied' | 'expired' };
export interface FeishuActivateResponse { ok: boolean }
export type FeishuBindingInfoResponse = { bound: false } | { bound: true; status: 'pending_approval' | 'active'; app_id: string };
```

- [ ] **Step 2: api.ts**

```ts
export const feishuScanStart = (): Promise<FeishuScanStartResponse> => json('/api/feishu/bind/scan-start', { method: 'POST' });
export const feishuScanPoll = (deviceCode: string): Promise<FeishuScanPollResponse> => json('/api/feishu/bind/scan-poll', { method: 'POST', body: JSON.stringify({ deviceCode }) });
export const feishuActivate = (): Promise<FeishuActivateResponse> => json('/api/feishu/bind/activate', { method: 'POST' });
export const getMyFeishuBind = (): Promise<FeishuBindingInfoResponse> => json('/api/feishu/bind');
export const unbindFeishu = (): Promise<{ ok: true }> => json('/api/feishu/bind/unbind', { method: 'POST' });
```

- [ ] **Step 3: build shared + web**

Run: `pnpm --filter @lingxi/shared build && pnpm --filter @lingxi/web build 2>&1 | tail -3` → 绿。

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/contracts.ts apps/web/src/lib/api.ts
git commit -m "feat(feishu): shared 契约 + web 绑定 API"
```

---

### Task 14: 前端 IM Hub 接通飞书绑定

**Files:** Create `apps/web/src/states/useFeishuBind.ts`；Modify `apps/web/src/apps/im/providers.tsx`（飞书 provider 已注册图标，接上绑定动作）；可能复用 `IMBindDialog`

> 飞书绑定流是**两步**（扫码建 app → 管理员审批 → "我已审批"激活），与微信单步不同。执行时先读 `apps/web/src/apps/im/providers.tsx` 和现有 `useWechatBind` / `IMBindDialog` 结构，决定复用程度。

- [ ] **Step 1: `useFeishuBind` 状态机**

状态：`idle → scanning(qrUrl, 轮询 feishuScanPoll) → pending_approval(展示后台深链 adminConsoleUrl + "我已审批"按钮) → activating(feishuActivate) → active | error`。轮询节奏用 `scan-start` 返回的 `interval`。

- [ ] **Step 2: 接 providers.tsx**

飞书 provider 的"绑定"动作触发 `useFeishuBind`；三态卡片（未绑/待审批/已接入）复用 IMProviderCard。

- [ ] **Step 3: build web 绿**

Run: `pnpm --filter @lingxi/web build 2>&1 | tail -3` → 绿。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/states/useFeishuBind.ts apps/web/src/apps/im/providers.tsx
git commit -m "feat(web): IM Hub 接通飞书绑定(扫码+审批两步)"
```

---

## Phase 6 — 配置 + 冒烟

### Task 15: env 三处守则（`FEISHU_ENABLED` + `FEISHU_DOMAIN`）

**Files:** Modify `apps/gateway/.env.example`、`apps/gateway/src/config.ts`、`infra/bicep/main.bicep`（CLAUDE.md 强约束：新 env 同步三处）

- [ ] **Step 1: 三处同步加**

- `.env.example`：`FEISHU_ENABLED=false` + `FEISHU_DOMAIN=feishu`
- `config.ts`：`feishu: { enabled: process.env['FEISHU_ENABLED'] === 'true', domain: process.env['FEISHU_DOMAIN'] ?? 'feishu' }`
- `main.bicep` appSettings：`FEISHU_ENABLED` / `FEISHU_DOMAIN`（非敏感，明文，不走 KeyVault）

`index.ts` 用 `config.feishu.enabled` 门控 connMgr 构造与路由挂载。

- [ ] **Step 2: build 全绿 + commit**

Run: `pnpm -r build 2>&1 | grep -iE "error|Done" | tail` → 全 Done。
```bash
git add apps/gateway/.env.example apps/gateway/src/config.ts infra/bicep/main.bicep apps/gateway/src/index.ts
git commit -m "feat(feishu): FEISHU_ENABLED/FEISHU_DOMAIN env 三处同步"
```

---

### Task 16: 全量回归 + 冒烟（交付门，遵守 smoke-test-before-done 记忆）

- [ ] **Step 1: 全量测试**

Run: `cd /Users/yanjiayi/workspace/laifu && pnpm -r test 2>&1 | grep -iE "Test Files|Tests |FAIL"`
Expected: 飞书相关全绿；仅剩 main 已知 baseline 失败（wechat-ilink 3 个 + web CapabilityAction），无新增。

- [ ] **Step 2: 全量 build**

Run: `pnpm -r build 2>&1 | grep -iE "error|Done"` → 全 Done（重点确认 gateway 把 larksuite SDK 打进单文件，spec §9.4）。

- [ ] **Step 3: 真跑 dev 冒烟**

Run: `FEISHU_ENABLED=true pnpm dev`（或单起 gateway）。验证：gateway 起得来不崩、`startAll` 无 active binding 时安全空跑、`curl -s -o /dev/null -w "%{http_code}" localhost:9000/api/feishu/bind`（未登录）回 401。无 binding 时 connMgr.size()=0，进程稳定。

- [ ] **Step 4: 部署冒烟（可选，spec §9.4）**

`./scripts/build-deploy.sh` 产物里确认 larksuite SDK 已打包进 `app-service-deploy/`；部署 dev 后 gateway 正常起。

- [ ] **Step 5: 真实闭环（需飞书企业管理员账号）**

网页扫码 → 管理员后台 approve → "我已审批" → 飞书私聊发消息 → 收到 Hermes 回复。记录到执行笔记。

---

## 自检（Self-Review 已过）

- **spec 覆盖**：§5 绑定流→Task 12/14；§6 运行时→Task 8/9；§6.4 探针→Task 7；§7 数据→Task 2/3；§8 改动点 1-5→Task 2/10/11/15；§5.2 registration→Task 5；§6.2 client→Task 6。全覆盖。
- **类型一致**：`FeishuBinding`(Task 3) 贯穿 8/9/11；`feishuReplyContexts` 形状 `{toOpenId, client}` 在 8/11 一致；`AppRegistrationResult.{appId,appSecret,domain,ownerOpenId}` 在 5/12 一致。
- **明确占位**：移植类 task（5/6/7）刻意以"源文件为准 + 精确改写清单 + 必须导出签名"表达，不抄 300 行；运行时复用点（warmContainerUrl/storePendingLoop 真实签名、SDK 事件键）已标注"执行时对照真实 API 修正"——这些是 openclaw/SDK 的真实接口，需打开文件确认，非可凭空写死。

## 执行笔记（实现中填）

- larksuite SDK 打包结果：
- `warmContainerUrl`/`storePendingLoop` 真实签名：
- SDK `EventDispatcher` 事件注册真实 API：
- 闭环冒烟结果：
