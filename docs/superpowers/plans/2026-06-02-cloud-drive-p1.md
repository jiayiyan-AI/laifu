# Cloud Drive — P1 Entitlement + Token + Observed 闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 P0 基建（SAS builder / UDK cache / virtual-path）之上，把 entitlement 系统的"控制面闭环"接通 —— DB schema + gateway 路由 + provisioning hook + 容器侧 entrypoint 软链 + JWT 续签 —— 让 P5（"启用云盘"按钮）和 P3（agent 装 cloud-publish skill）有可用的后端。

**Architecture:**
- 控制面：gateway 维护 `user_entitlements` 表（active 判定 = `disabled_at IS NULL`），通过 `/api/entitlements/cloud/{enable,disable}` 修改；同时 bump `users.token_version` 撤销旧 JWT；触发容器重启
- 容器侧反馈：每次重启后 entrypoint 调 `/api/me/entitlements` 拉 desired 列表，按列表软链 `~/.hermes/skills/*`，完成后调 `/api/me/observed-entitlements` 上报；gateway 把 observed 状态合并进 `/api/status` 让前端等到容器真生效
- 鉴权：容器拿 90 天 JWT（payload 含 `user_id` + `token_version`）调 gateway 时验签 + 校验 token_version 匹配，让"撤销"只需 bump 一行 DB；容器 entrypoint 检测 token 临近过期则调 `/api/auth/refresh-token` 续签（7 天 grace 允许已过期 token 短期内续）

**Tech Stack:**
- Supabase / PostgreSQL（已搭好）
- Node.js 24 / TypeScript / Express / vitest（gateway）
- `jsonwebtoken@^9.0.3`（已装）
- `@azure/arm-appcontainers@^2.0.0`（已装，用 `restartRevision`）
- 容器 entrypoint 用 bash + `curl` + `jq`

**Out of scope for P1:**
- gateway `/api/cloud/sas` `/list` `/download` 路由 → P2
- `cloud-publish` Hermes skill 实现 → P3（本 plan 只准备好"软链点"，skill 文件在 `/opt/hermes-skills/cloud_publish/` 用占位 README，确保软链命令不报错）
- Files App / ManageApp UI → P4-P6

**Spec reference:** `docs/superpowers/specs/2026-06-01-cloud-drive-design.md` §三（entitlement 表）/ §四（流程 + JWT 设计）/ §五（API + middleware）/ §十 P1 行

---

## File Structure (P1 范围)

```
新增 — supabase migration:
  infra/supabase/migrations/0006_cloud_entitlements.sql      建 user_entitlements + container_observed_state + users.token_version

新增 — packages/shared:
  (扩展) packages/shared/src/contracts.ts                    + EntitlementsList / ObservedEntitlementsReport / RefreshTokenResponse + StatusResponse 加 entitlements 字段

新增 — gateway lib:
  apps/gateway/src/lib/gateway-token.ts                       JWT 签 + 验（含 token_version 比对）
  apps/gateway/test/lib/gateway-token.test.ts

新增 — gateway middleware:
  apps/gateway/src/auth/container-token.ts                    Express middleware：验 JWT + 设 req.user_id
  apps/gateway/test/auth/container-token.test.ts

新增 — gateway DAO:
  apps/gateway/src/db/entitlements-dao.ts                     upsertActive / disable / listActive / bumpTokenVersion
  apps/gateway/test/db/entitlements-dao.test.ts
  apps/gateway/src/db/observed-state-dao.ts                   upsert / get
  apps/gateway/test/db/observed-state-dao.test.ts

新增 — gateway API 路由:
  apps/gateway/src/api/entitlements.ts                         /api/entitlements/cloud/{enable,disable}
  apps/gateway/test/api/entitlements.test.ts
  apps/gateway/src/api/me-entitlements.ts                      /api/me/entitlements (GET) + /api/me/observed-entitlements (POST)
  apps/gateway/test/api/me-entitlements.test.ts
  apps/gateway/src/api/auth-refresh.ts                         /api/auth/refresh-token (POST，含 grace)
  apps/gateway/test/api/auth-refresh.test.ts

修改:
  apps/gateway/src/api/status.ts                              + desired/observed entitlements + containerStatus
  apps/gateway/test/api/status.test.ts                        新增（status 之前没单测）
  apps/gateway/src/index.ts                                    + 注册新路由 + 实例化 EntitlementsDao + ObservedStateDao
  apps/gateway/src/provisioning/azure.ts                      + injectLaifuUserToken helper + restartContainerApp helper
  apps/gateway/src/provisioning/local.ts                      + provisionContainerLocal 也写 token 到本地 mock
  apps/gateway/test/provisioning/*.test.ts                     需要时补 token 注入测试

  docker/hermes/entrypoint.sh                                  + step 5/6/7: 续签 token / 拉 entitlements / 软链 skills / 上报 observed
  docker/hermes/Dockerfile                                     + /opt/hermes-skills/cloud_publish/ 占位 + RUN apt-get install jq

新增 — 占位文件:
  docker/hermes/skills/cloud_publish/SKILL.md                  P3 会替换；P1 只占位
```

每个 src 文件单一职责：

| 文件 | 职责 |
|---|---|
| `gateway-token.ts` | 纯函数：签发 / 验签 JWT，含 `token_version` 校验 |
| `container-token.ts` | Express middleware：调 gateway-token 并把 `user_id` 挂 `req` 上 |
| `entitlements-dao.ts` | 操作 `user_entitlements` 表 + bump `users.token_version` |
| `observed-state-dao.ts` | 操作 `container_observed_state` 表 |
| `entitlements.ts` | `/api/entitlements/cloud/*`：业务编排（DAO 调用 + token bump + restart） |
| `me-entitlements.ts` | `/api/me/entitlements` GET + `/api/me/observed-entitlements` POST（容器视角） |
| `auth-refresh.ts` | `/api/auth/refresh-token`：grace 验签 → 拿 fresh token_version → 重签 |
| `status.ts`（改） | 合并 desired + observed entitlements 到响应 |
| `provisioning/azure.ts`（改） | `injectLaifuUserToken` + `restartContainerApp` 暴露给 entitlements 路由用 |
| `entrypoint.sh`（改） | 容器视角：续签 → 拉 desired → 软链 → 上报 observed |

---

## Task 0: 起步检查

**Files:** 无

- [ ] **Step 1: 在正确分支且工作树干净**

Run: `git status && git branch --show-current`
Expected:
```
On branch feat/cloud-drive
nothing to commit, working tree clean
```

如果有未提交改动（例如上次的 `supabase/config.toml` 精简），先 commit 或 stash。

- [ ] **Step 2: P0 已完成**

Run: `git log --oneline main..HEAD | head -10`
Expected: 看到 P0 的 17 个 commit（最近的是 `ba71e7f feat(scripts): P0 acceptance ...`）。

- [ ] **Step 3: Supabase 在跑 + 表都在**

Run:
```bash
supabase status --workdir /Users/yanjiayi/workspace/laifu/infra 2>&1 | head -10
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c "\dt public.*"
```
Expected: supabase status 显示 db/api/studio 都在跑；`\dt` 列出 5 个现有表（不含 `user_entitlements`/`container_observed_state`，那是 P1 要建的）。

- [ ] **Step 4: 测试 baseline**

Run: `pnpm --filter @lingxi/gateway test`
Expected: 153/153 passing (P0 收尾状态)。

---

## Task 1: DB Migration — entitlements + observed_state + token_version

**Files:**
- Create: `infra/supabase/migrations/0006_cloud_entitlements.sql`

迁移做三件事，但都属于 entitlement 域，一起写：建 `user_entitlements`、建 `container_observed_state`、给 `users` 加 `token_version` 列。

参考现有 migration（`0005_wechat_ilink_bindings.sql`）的注释风格：先讲设计要点，再写 DDL。

不写 RLS —— 跟现有迁移一致；gateway 用 service_role_key 直接读写，绕过 RLS。

- [ ] **Step 1: 创建迁移文件**

Create `infra/supabase/migrations/0006_cloud_entitlements.sql`:

```sql
-- P1: Cloud Drive entitlement 控制面闭环
-- spec: docs/superpowers/specs/2026-06-01-cloud-drive-design.md §三 + §四
--
-- 三张改动:
--   1. user_entitlements — 用户开通了哪些 feature（cloud / 未来 wechat_pro ...）
--   2. container_observed_state — 容器 entrypoint 上报实际加载的 skill / token 版本，
--      让前端"启用云盘"等待 modal 能等到容器真生效
--   3. users.token_version — 单调递增计数器；entitlement enable/disable 时 +1，
--      让旧 LAIFU_USER_TOKEN 立刻失效（无需等 90 天 exp）
--
-- 设计要点:
--   - active 定义 = disabled_at IS NULL（不是"行存在"，否则 disable 后再 enable 卡住）
--   - 部分索引只覆盖 active 行，签 SAS 时查询走索引
--   - container_observed_state 单行 per user（PK 是 user_id），上报覆盖
--   - token_version 起步 0；签的第一个 JWT 也带 token_version=0

create table user_entitlements (
  user_id     uuid not null references users(id) on delete cascade,
  feature     text not null,                              -- 'cloud' (P1); 未来 'wechat_pro' 等
  enabled_at  timestamptz not null default now(),
  disabled_at timestamptz,                                -- NULL = active；NOT NULL = 已停用
  metadata    jsonb,                                       -- 留扩展位（套餐版本号 / 备注）
  primary key (user_id, feature)
);

-- active 判定: disabled_at IS NULL。部分索引让 listActive 走索引。
create index user_entitlements_active
  on user_entitlements (user_id, feature)
  where disabled_at is null;

create table container_observed_state (
  user_id                 uuid primary key references users(id) on delete cascade,
  observed_entitlements   text[] not null default '{}',   -- 容器实际软链好的 feature 列表
  observed_token_version  int not null default 0,         -- 容器最后一次重启时 JWT 里的 token_version
  reported_at             timestamptz not null default now()
);

-- users.token_version: 给已存在的行兜底 0。新行默认 0（DEFAULT 子句）。
alter table users
  add column token_version int not null default 0;
```

- [ ] **Step 2: 应用迁移到本地**

Run: `cd /Users/yanjiayi/workspace/laifu/infra && supabase migration up --local`
Expected: `Applying migration 0006_cloud_entitlements.sql... Local database is up to date.`

- [ ] **Step 3: 验证表结构**

Run:
```bash
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c "\d user_entitlements"
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c "\d container_observed_state"
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c "\d users" | grep token_version
```
Expected:
- `user_entitlements` 有 5 列 + PK + 部分索引 `user_entitlements_active`
- `container_observed_state` 有 4 列 + PK
- `users` 表的 `\d` 输出含 `token_version | integer | not null | default 0`

- [ ] **Step 4: Commit**

```bash
git add infra/supabase/migrations/0006_cloud_entitlements.sql
git commit -m "feat(db): cloud entitlements + observed state + users.token_version"
```

---

## Task 2: Shared Contracts — Entitlement types

**Files:**
- Modify: `packages/shared/src/contracts.ts`

P1 的 6 个端点都需要类型；同时把 `StatusResponse` 加上 `entitlements_desired` / `entitlements_observed` / `container_status` 字段。

- [ ] **Step 1: 扩展 contracts**

在 `packages/shared/src/contracts.ts` **末尾追加**（位于 P0 的 `CloudWriteSasResponse` / `CloudSasPermission` 之后）：

```typescript

// === P1 Entitlement / Token 契约 ===

/**
 * 容器侧拉取自己开通的 features (GET /api/me/entitlements)。
 * 返回的 entitlements 已经过 active 过滤（disabled_at IS NULL）。
 */
export interface EntitlementsList {
  entitlements: string[];   // e.g. ['cloud']
  token_version: number;    // 当前 users.token_version；容器据此决定是否需要续签
}

/**
 * 容器 entrypoint 完成 skill 软链后回报 (POST /api/me/observed-entitlements)。
 * gateway 写到 container_observed_state，让前端等待 modal 能等到容器真生效。
 */
export interface ObservedEntitlementsReport {
  observed: string[];        // 实际软链到 ~/.hermes/skills/ 的 feature 列表
  token_version: number;     // 容器启动时 JWT 里的 token_version；让 gateway 检测版本漂移
}

/**
 * 续签端点 (POST /api/auth/refresh-token)。响应是新 token。
 * 请求体为空，鉴权靠 Authorization: Bearer <旧 token>（含 grace 接受）。
 */
export interface RefreshTokenResponse {
  token: string;             // 新签 JWT (90d exp)
  expires_at: string;        // ISO-8601, exp 字段的人可读形式
}

/**
 * Entitlement 修改端点的响应 (POST /api/entitlements/{feature}/{enable,disable})。
 * 返回当前 active entitlements。restart 是异步触发的，前端用 /api/status 轮询。
 */
export interface EntitlementChangeResponse {
  ok: true;
  entitlements: string[];
  changed: boolean;           // 是否真发生了状态变更 (active <-> disabled)
}
```

在文件中**找到现有 `StatusResponse`** (来自 P0 之前的代码)，替换为扩展版本：

```typescript
export interface StatusResponse {
  status: 'provisioning' | 'ready' | 'failed';
  provisioning_step: string | null;
  progress_pct: number;
  error_message: string | null;
  // P1 加: entitlement 闭环字段
  entitlements_desired: string[];    // user_entitlements 表里 active 的 feature
  entitlements_observed: string[];   // container_observed_state 里容器最后报告的
  container_token_version: number;   // 当前 users.token_version（前端用来比对 observed）
}
```

⚠️ 注意：`apps/gateway/src/api/status.ts` 目前没把这些字段返回出来 —— Task 9 会改它。这里只是改 type definition，gateway src 改完 type 才会编译过。

⚠️ 注意：`apps/web/` 也可能 import `StatusResponse`。本 task 加字段后，web 端如果 destructure 这些字段会拿到 `undefined`（直到 gateway 也返回它们）。但 P1 范围不动 web，**接受这个"中间状态"**：tests 不会挂（vitest 不强校验未定义字段），运行时 web 拿到的旧 response 还是只有原 4 个字段。新字段 web 在 P5/P6 用上时再处理。

- [ ] **Step 2: 编译验证**

```bash
pnpm --filter @lingxi/shared run lint
pnpm --filter @lingxi/gateway run lint     # 会报告 status.ts 用的字段缺，但本 task 不动 status.ts —— 在 Task 9 一并修
```

预期：`@lingxi/shared` lint clean。`@lingxi/gateway` lint **可能** 报 `status.ts` 漏字段 —— 这是预期的，因为 Task 9 还没做。**如果 lint 报错挡住 Task 2 commit，把 `StatusResponse` 新增字段标 optional**：

```typescript
  entitlements_desired?: string[];
  entitlements_observed?: string[];
  container_token_version?: number;
```

然后 Task 9 把 `?` 去掉。

实际推荐：先用 optional 字段保持渐进，Task 9 改完 status.ts 后**再**单独一个小 commit 去掉 `?` 收紧类型。

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/contracts.ts
git commit -m "feat(shared): entitlement + token + status contracts for P1"
```

---

## Task 3: JWT lib (`gateway-token.ts`) — TDD

**Files:**
- Create: `apps/gateway/src/lib/gateway-token.ts`
- Create: `apps/gateway/test/lib/gateway-token.test.ts`

`gateway-token` 提供两个函数：
- `signLaifuUserToken({ userId, tokenVersion })` → JWT 字符串（exp = iat + 90d）
- `verifyLaifuUserToken(jwt, expectedTokenVersion)` → `{ userId, tokenVersion, iat, exp }` 或 throw

`gatewaySecret` 从 `config.auth.gatewaySecret` 拿（P0 Task 2-3 已加到 config）。

- [ ] **Step 1: 写失败测试**

Create `apps/gateway/test/lib/gateway-token.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import {
  signLaifuUserToken,
  verifyLaifuUserToken,
  TokenExpiredError,
  TokenVersionMismatchError,
  TokenInvalidError,
} from '../../src/lib/gateway-token.js';

const SECRET = 'test-secret-1234567890';
const USER_ID = '6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f';

describe('gateway-token', () => {
  describe('sign + verify happy path', () => {
    it('round-trips userId and tokenVersion', () => {
      const token = signLaifuUserToken({ userId: USER_ID, tokenVersion: 3, secret: SECRET });
      const payload = verifyLaifuUserToken(token, { expectedTokenVersion: 3, secret: SECRET });
      expect(payload.userId).toBe(USER_ID);
      expect(payload.tokenVersion).toBe(3);
      expect(payload.exp - payload.iat).toBe(90 * 24 * 3600);
    });

    it('exp is 90 days from now', () => {
      const before = Math.floor(Date.now() / 1000);
      const token = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: SECRET });
      const after = Math.floor(Date.now() / 1000);
      const payload = verifyLaifuUserToken(token, { expectedTokenVersion: 0, secret: SECRET });
      expect(payload.exp).toBeGreaterThanOrEqual(before + 90 * 24 * 3600);
      expect(payload.exp).toBeLessThanOrEqual(after + 90 * 24 * 3600);
    });
  });

  describe('verification failures', () => {
    it('throws TokenVersionMismatchError when versions differ', () => {
      const token = signLaifuUserToken({ userId: USER_ID, tokenVersion: 1, secret: SECRET });
      expect(() =>
        verifyLaifuUserToken(token, { expectedTokenVersion: 2, secret: SECRET }),
      ).toThrow(TokenVersionMismatchError);
    });

    it('throws TokenInvalidError on tampered signature', () => {
      const token = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: SECRET });
      const tampered = token.slice(0, -4) + 'AAAA';
      expect(() =>
        verifyLaifuUserToken(tampered, { expectedTokenVersion: 0, secret: SECRET }),
      ).toThrow(TokenInvalidError);
    });

    it('throws TokenInvalidError on wrong secret', () => {
      const token = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: SECRET });
      expect(() =>
        verifyLaifuUserToken(token, { expectedTokenVersion: 0, secret: 'wrong-secret' }),
      ).toThrow(TokenInvalidError);
    });

    it('throws TokenExpiredError on expired token', () => {
      // 用 fake time 让 token 立刻过期：sign 时返回当前 iat，verify 时跳到 100 天后
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const token = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: SECRET });
      vi.setSystemTime(new Date('2026-04-15T00:00:00Z')); // 104 days later
      expect(() =>
        verifyLaifuUserToken(token, { expectedTokenVersion: 0, secret: SECRET }),
      ).toThrow(TokenExpiredError);
      vi.useRealTimers();
    });
  });

  describe('grace mode (for refresh-token)', () => {
    it('verifyLaifuUserToken with allowExpiredWithinDays=7 accepts a 5-day-expired token', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const token = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: SECRET });
      vi.setSystemTime(new Date('2026-04-06T00:00:00Z')); // 95 days later: token expired 5d ago
      const payload = verifyLaifuUserToken(token, {
        expectedTokenVersion: 0,
        secret: SECRET,
        allowExpiredWithinDays: 7,
      });
      expect(payload.userId).toBe(USER_ID);
      vi.useRealTimers();
    });

    it('verifyLaifuUserToken with allowExpiredWithinDays=7 rejects an 8-day-expired token', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const token = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: SECRET });
      vi.setSystemTime(new Date('2026-04-09T00:00:00Z')); // 98 days later: token expired 8d ago
      expect(() =>
        verifyLaifuUserToken(token, {
          expectedTokenVersion: 0,
          secret: SECRET,
          allowExpiredWithinDays: 7,
        }),
      ).toThrow(TokenExpiredError);
      vi.useRealTimers();
    });
  });
});
```

- [ ] **Step 2: 跑测试看 fail**

```bash
pnpm --filter @lingxi/gateway test -- gateway-token
```
Expected: 报 `Cannot find module '../../src/lib/gateway-token.js'`.

- [ ] **Step 3: 实现**

Create `apps/gateway/src/lib/gateway-token.ts`:

```typescript
import jwt from 'jsonwebtoken';

const TOKEN_LIFETIME_SECONDS = 90 * 24 * 3600;   // 90d
const ALGORITHM: jwt.Algorithm = 'HS256';

export class TokenInvalidError extends Error {
  constructor(message = 'invalid token') {
    super(message);
    this.name = 'TokenInvalidError';
  }
}

export class TokenExpiredError extends Error {
  constructor(message = 'token expired') {
    super(message);
    this.name = 'TokenExpiredError';
  }
}

export class TokenVersionMismatchError extends Error {
  constructor(message = 'token_version mismatch (token revoked)') {
    super(message);
    this.name = 'TokenVersionMismatchError';
  }
}

export interface SignInput {
  userId: string;
  tokenVersion: number;
  secret: string;
}

export interface VerifyInput {
  expectedTokenVersion: number;
  secret: string;
  /**
   * If set, accept tokens that expired up to this many days ago.
   * Used by /api/auth/refresh-token to let a container that slept past
   * exp still get a new token (within grace).
   */
  allowExpiredWithinDays?: number;
}

export interface DecodedPayload {
  userId: string;
  tokenVersion: number;
  iat: number;
  exp: number;
}

interface JwtPayload {
  user_id: string;
  token_version: number;
  iat: number;
  exp: number;
}

export function signLaifuUserToken(input: SignInput): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: JwtPayload = {
    user_id: input.userId,
    token_version: input.tokenVersion,
    iat: now,
    exp: now + TOKEN_LIFETIME_SECONDS,
  };
  // We control iat/exp ourselves (jsonwebtoken's `expiresIn` would also work, but
  // explicit control is clearer for tests + the grace logic below).
  return jwt.sign(payload, input.secret, { algorithm: ALGORITHM, noTimestamp: true });
}

export function verifyLaifuUserToken(token: string, input: VerifyInput): DecodedPayload {
  // Step 1: signature + structural verification with skew tolerance for grace.
  // `ignoreExpiration: true` skips JWT's built-in exp check; we do it ourselves below
  // so grace mode can accept short-expired tokens.
  let raw: JwtPayload;
  try {
    raw = jwt.verify(token, input.secret, {
      algorithms: [ALGORITHM],
      ignoreExpiration: true,
    }) as JwtPayload;
  } catch (err) {
    throw new TokenInvalidError(err instanceof Error ? err.message : 'invalid token');
  }

  // Step 2: shape validation
  if (typeof raw.user_id !== 'string' || typeof raw.token_version !== 'number'
      || typeof raw.iat !== 'number' || typeof raw.exp !== 'number') {
    throw new TokenInvalidError('payload shape invalid');
  }

  // Step 3: token_version check
  if (raw.token_version !== input.expectedTokenVersion) {
    throw new TokenVersionMismatchError(
      `expected token_version ${input.expectedTokenVersion}, got ${raw.token_version}`,
    );
  }

  // Step 4: expiration check (with optional grace)
  const now = Math.floor(Date.now() / 1000);
  const graceSec = (input.allowExpiredWithinDays ?? 0) * 24 * 3600;
  if (raw.exp + graceSec < now) {
    throw new TokenExpiredError(
      `token expired at ${new Date(raw.exp * 1000).toISOString()}`,
    );
  }

  return {
    userId: raw.user_id,
    tokenVersion: raw.token_version,
    iat: raw.iat,
    exp: raw.exp,
  };
}
```

- [ ] **Step 4: 跑测试看 pass**

```bash
pnpm --filter @lingxi/gateway test -- gateway-token
```
Expected: 9/9 passing.

- [ ] **Step 5: Lint**

```bash
pnpm --filter @lingxi/gateway run lint
```
Expected: clean (Task 2 的 status.ts 类型问题前面已经做了 optional 字段的兜底；如果还是有错回去把 `StatusResponse` 新字段标 `?`)。

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/lib/gateway-token.ts apps/gateway/test/lib/gateway-token.test.ts
git commit -m "feat(gateway): JWT sign + verify with token_version + grace mode"
```

---

## Task 4: container-token middleware — TDD

**Files:**
- Create: `apps/gateway/src/auth/container-token.ts`
- Create: `apps/gateway/test/auth/container-token.test.ts`

Express middleware：读 `Authorization: Bearer <jwt>` → 验签 + token_version → 把 `userId` 挂 `req.user_id`。需要查 DB 拿当前 `users.token_version` 才能比对。

DAO 还没做（Task 5），先把 middleware 写成接受 fetcher 注入的形式，测试用 mock，DAO 上线后路由层组装时传 DAO 方法过去。

- [ ] **Step 1: 写失败测试**

Create `apps/gateway/test/auth/container-token.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { makeContainerTokenMiddleware } from '../../src/auth/container-token.js';
import { signLaifuUserToken } from '../../src/lib/gateway-token.js';

const SECRET = 'test-secret-1234567890';
const USER_ID = '6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f';

function makeApp(tokenVersionFetcher: (userId: string) => Promise<number | null>) {
  const app = express();
  app.use(makeContainerTokenMiddleware({ secret: SECRET, tokenVersionFetcher }));
  app.get('/whoami', (req, res) => res.json({ user_id: (req as any).user_id }));
  return app;
}

describe('container-token middleware', () => {
  it('200 when token is valid and version matches', async () => {
    const fetcher = vi.fn().mockResolvedValue(0);
    const token = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: SECRET });
    const res = await request(makeApp(fetcher))
      .get('/whoami')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(USER_ID);
    expect(fetcher).toHaveBeenCalledWith(USER_ID);
  });

  it('401 when Authorization header missing', async () => {
    const res = await request(makeApp(vi.fn())).get('/whoami');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/missing|authorization/i);
  });

  it('401 when scheme is not Bearer', async () => {
    const res = await request(makeApp(vi.fn()))
      .get('/whoami')
      .set('Authorization', 'Basic abc');
    expect(res.status).toBe(401);
  });

  it('401 when token is invalid', async () => {
    const res = await request(makeApp(vi.fn()))
      .get('/whoami')
      .set('Authorization', 'Bearer not-a-jwt');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it('401 when user_id has no token_version row (deleted user)', async () => {
    const fetcher = vi.fn().mockResolvedValue(null);
    const token = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: SECRET });
    const res = await request(makeApp(fetcher))
      .get('/whoami')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/unknown|user/i);
  });

  it('401 when token_version mismatch (revoked)', async () => {
    const fetcher = vi.fn().mockResolvedValue(1);  // DB version is 1
    const token = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: SECRET }); // token has 0
    const res = await request(makeApp(fetcher))
      .get('/whoami')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/revoked|version/i);
  });
});
```

- [ ] **Step 2: 跑测试看 fail**

```bash
pnpm --filter @lingxi/gateway test -- container-token
```
Expected: module not found.

- [ ] **Step 3: 实现**

Create `apps/gateway/src/auth/container-token.ts`:

```typescript
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import {
  verifyLaifuUserToken,
  TokenInvalidError,
  TokenExpiredError,
  TokenVersionMismatchError,
} from '../lib/gateway-token.js';

export interface ContainerTokenMiddlewareOptions {
  secret: string;
  /**
   * 查给定 userId 当前的 users.token_version；返回 null 表示用户不存在
   * (DAO 会做这个查询；测试里 mock)。
   */
  tokenVersionFetcher: (userId: string) => Promise<number | null>;
}

declare module 'express-serve-static-core' {
  interface Request {
    user_id?: string;
  }
}

export const makeContainerTokenMiddleware = (
  opts: ContainerTokenMiddlewareOptions,
): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) {
      res.status(401).json({ error: 'missing or non-Bearer Authorization header' });
      return;
    }
    const token = header.slice(7);

    // Decode WITHOUT version check first to get user_id, then query DB for the
    // current token_version, then re-verify with the actual expected version.
    // (Alternative: jwt.decode + handcrafted version compare. Cleaner to delegate
    //  to verifyLaifuUserToken twice but that signs twice; in practice one decode
    //  + one verify is enough.)
    let userId: string;
    let tokenVersionFromToken: number;
    try {
      // Pass a sentinel expectedTokenVersion to skip the version check by passing
      // the value we'll set after the DB query. To do this cheaply, just decode
      // first to peek at user_id and token_version, then verify with the correct
      // expected version (re-using jwt's signature check).
      const peeked = peekJwtPayload(token);
      userId = peeked.user_id;
      tokenVersionFromToken = peeked.token_version;
    } catch (err) {
      res.status(401).json({ error: 'invalid token' });
      return;
    }

    const currentVersion = await opts.tokenVersionFetcher(userId);
    if (currentVersion === null) {
      res.status(401).json({ error: 'unknown user' });
      return;
    }

    try {
      const payload = verifyLaifuUserToken(token, {
        expectedTokenVersion: currentVersion,
        secret: opts.secret,
      });
      req.user_id = payload.userId;
      next();
    } catch (err) {
      if (err instanceof TokenVersionMismatchError) {
        res.status(401).json({ error: 'token revoked (version mismatch)' });
        return;
      }
      if (err instanceof TokenExpiredError) {
        res.status(401).json({ error: 'token expired' });
        return;
      }
      if (err instanceof TokenInvalidError) {
        res.status(401).json({ error: 'invalid token' });
        return;
      }
      res.status(500).json({ error: 'internal' });
    }
  };
};

/**
 * Peek at a JWT payload without verifying signature — used only to extract user_id
 * before we can know which DB row to query for the expected token_version. The actual
 * security check happens in verifyLaifuUserToken below.
 */
interface PeekedPayload {
  user_id: string;
  token_version: number;
}
function peekJwtPayload(token: string): PeekedPayload {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('not a jwt');
  const payloadJson = Buffer.from(parts[1]!, 'base64url').toString('utf8');
  const raw = JSON.parse(payloadJson);
  if (typeof raw.user_id !== 'string' || typeof raw.token_version !== 'number') {
    throw new Error('payload shape invalid');
  }
  return { user_id: raw.user_id, token_version: raw.token_version };
}
```

- [ ] **Step 4: 跑测试看 pass**

```bash
pnpm --filter @lingxi/gateway test -- container-token
```
Expected: 6/6 passing.

- [ ] **Step 5: Lint**

```bash
pnpm --filter @lingxi/gateway run lint
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/auth/container-token.ts apps/gateway/test/auth/container-token.test.ts
git commit -m "feat(gateway): container-token middleware (JWT + token_version)"
```

---

## Task 5: Entitlements DAO + Observed-state DAO

**Files:**
- Create: `apps/gateway/src/db/entitlements-dao.ts`
- Create: `apps/gateway/test/db/entitlements-dao.test.ts`
- Create: `apps/gateway/src/db/observed-state-dao.ts`
- Create: `apps/gateway/test/db/observed-state-dao.test.ts`

两个 DAO 放一个 task；它们都是薄包装 Supabase。测试用 supabase-js mock（之前 wechat-binding-dao 怎么测的，照抄风格）。

如果现有项目用真 Supabase 做集成测试（local supabase 在跑），可以走集成测试路径，更可信。看 `apps/gateway/test/db/` 是否有 .test.ts 例子。

- [ ] **Step 1: 看现有 DAO 测试风格**

Run:
```bash
ls apps/gateway/test/db/ 2>/dev/null
cat apps/gateway/src/db/wechat-binding-dao.ts | head -30
```

如果 `apps/gateway/test/db/` 不存在或为空，沿用 mock 风格；否则跟现有保持一致。

- [ ] **Step 2: 写 entitlements-dao 测试**

Create `apps/gateway/test/db/entitlements-dao.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeEntitlementsDao } from '../../src/db/entitlements-dao.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const USER_ID = '6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f';

function fakeSb() {
  // 极简 mock: 让 .from('x').{select,upsert,update}().eq().select().single() 都返回可控值
  const calls: Array<{ table: string; op: string; args: unknown[] }> = [];
  const mock: any = {
    from(table: string) {
      const ctx = {
        upsert: (...args: unknown[]) => { calls.push({ table, op: 'upsert', args }); return ctx; },
        update: (...args: unknown[]) => { calls.push({ table, op: 'update', args }); return ctx; },
        select: (...args: unknown[]) => { calls.push({ table, op: 'select', args }); return ctx; },
        eq:     (...args: unknown[]) => { calls.push({ table, op: 'eq', args }); return ctx; },
        is:     (...args: unknown[]) => { calls.push({ table, op: 'is', args }); return ctx; },
        single: () => Promise.resolve({ data: { token_version: 5 }, error: null }),
        then:   (cb: any) => Promise.resolve({ data: [], error: null }).then(cb),
      };
      return ctx;
    },
    rpc(name: string, params: any) {
      calls.push({ table: '__rpc__', op: name, args: [params] });
      return Promise.resolve({ data: 5, error: null });
    },
  };
  return { mock: mock as SupabaseClient, calls };
}

describe('EntitlementsDao', () => {
  describe('listActive', () => {
    it('queries user_entitlements with disabled_at IS NULL', async () => {
      const { mock, calls } = fakeSb();
      const dao = makeEntitlementsDao(mock);
      await dao.listActive(USER_ID);
      expect(calls.some(c => c.table === 'user_entitlements' && c.op === 'select')).toBe(true);
      expect(calls.some(c => c.op === 'is' && JSON.stringify(c.args) === JSON.stringify(['disabled_at', null]))).toBe(true);
    });
  });

  describe('enable', () => {
    it('upserts user_entitlements with disabled_at=null, enabled_at=now', async () => {
      const { mock, calls } = fakeSb();
      const dao = makeEntitlementsDao(mock);
      await dao.enable(USER_ID, 'cloud');
      const up = calls.find(c => c.table === 'user_entitlements' && c.op === 'upsert');
      expect(up).toBeDefined();
      const [row] = up!.args as any[];
      expect(row.user_id).toBe(USER_ID);
      expect(row.feature).toBe('cloud');
      expect(row.disabled_at).toBe(null);
      expect(row.enabled_at).toBeDefined();
    });
  });

  describe('disable', () => {
    it('updates disabled_at=now where active', async () => {
      const { mock, calls } = fakeSb();
      const dao = makeEntitlementsDao(mock);
      await dao.disable(USER_ID, 'cloud');
      const upd = calls.find(c => c.table === 'user_entitlements' && c.op === 'update');
      expect(upd).toBeDefined();
      const [patch] = upd!.args as any[];
      expect(patch.disabled_at).toBeDefined();
    });
  });

  describe('bumpTokenVersion', () => {
    it('increments users.token_version atomically (RPC or transactional UPDATE)', async () => {
      const { mock, calls } = fakeSb();
      const dao = makeEntitlementsDao(mock);
      const newVersion = await dao.bumpTokenVersion(USER_ID);
      // 实现可以用 RPC 函数（推荐）或 UPDATE ... SET token_version = token_version + 1 RETURNING
      // 测试不强校验具体实现，只校验 dao 返回了一个 number
      expect(typeof newVersion).toBe('number');
    });
  });

  describe('getTokenVersion', () => {
    it('returns the current users.token_version', async () => {
      const { mock } = fakeSb();
      const dao = makeEntitlementsDao(mock);
      const v = await dao.getTokenVersion(USER_ID);
      expect(v).toBe(5);
    });
  });
});
```

- [ ] **Step 3: 跑测试看 fail**

```bash
pnpm --filter @lingxi/gateway test -- entitlements-dao
```
Expected: module not found.

- [ ] **Step 4: 实现 entitlements-dao**

Create `apps/gateway/src/db/entitlements-dao.ts`:

```typescript
import type { SupabaseClient } from '@supabase/supabase-js';

export interface EntitlementsDao {
  /** 列出 user 当前 active 的 features (disabled_at IS NULL). */
  listActive(userId: string): Promise<string[]>;

  /** 启用 (或重新启用) 某 feature；返回是否真发生了状态变更. */
  enable(userId: string, feature: string): Promise<{ changed: boolean }>;

  /** 停用某 feature (disabled_at = now)；返回是否真发生了状态变更. */
  disable(userId: string, feature: string): Promise<{ changed: boolean }>;

  /** 拿 users.token_version. user 不存在返回 null. */
  getTokenVersion(userId: string): Promise<number | null>;

  /** 原子递增 token_version, 返回新值. */
  bumpTokenVersion(userId: string): Promise<number>;
}

export const makeEntitlementsDao = (sb: SupabaseClient): EntitlementsDao => {
  return {
    async listActive(userId) {
      const { data, error } = await sb
        .from('user_entitlements')
        .select('feature')
        .eq('user_id', userId)
        .is('disabled_at', null);
      if (error) throw new Error(`listActive: ${error.message}`);
      return (data ?? []).map((r) => (r as { feature: string }).feature);
    },

    async enable(userId, feature) {
      // 先查 active 状态以判断 changed
      const before = await sb
        .from('user_entitlements')
        .select('disabled_at')
        .eq('user_id', userId)
        .eq('feature', feature)
        .maybeSingle();

      const wasActive = before.data && (before.data as { disabled_at: string | null }).disabled_at === null;

      const { error } = await sb.from('user_entitlements').upsert(
        {
          user_id: userId,
          feature,
          enabled_at: new Date().toISOString(),
          disabled_at: null,
        },
        { onConflict: 'user_id,feature' },
      );
      if (error) throw new Error(`enable: ${error.message}`);

      return { changed: !wasActive };
    },

    async disable(userId, feature) {
      const { data, error } = await sb
        .from('user_entitlements')
        .update({ disabled_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('feature', feature)
        .is('disabled_at', null)
        .select();
      if (error) throw new Error(`disable: ${error.message}`);
      return { changed: (data?.length ?? 0) > 0 };
    },

    async getTokenVersion(userId) {
      const { data, error } = await sb
        .from('users')
        .select('token_version')
        .eq('id', userId)
        .maybeSingle();
      if (error) throw new Error(`getTokenVersion: ${error.message}`);
      if (!data) return null;
      return (data as { token_version: number }).token_version;
    },

    async bumpTokenVersion(userId) {
      // Atomic increment via RPC. 如果 Supabase 项目没建这个 RPC,先用 read-then-write
      // (有并发风险, P1 阶段单用户极少并发, 接受)。 推荐改成 RPC 函数:
      //   create or replace function bump_token_version(uid uuid) returns int as $$
      //     update users set token_version = token_version + 1 where id = uid returning token_version
      //   $$ language sql;
      // 这里先用 read-then-write 简易版,后续可替换。
      const cur = await this.getTokenVersion(userId);
      if (cur === null) throw new Error(`bumpTokenVersion: user ${userId} not found`);
      const next = cur + 1;
      const { error } = await sb
        .from('users')
        .update({ token_version: next })
        .eq('id', userId);
      if (error) throw new Error(`bumpTokenVersion: ${error.message}`);
      return next;
    },
  };
};
```

- [ ] **Step 5: 跑 entitlements-dao 测试看 pass**

```bash
pnpm --filter @lingxi/gateway test -- entitlements-dao
```
Expected: 5/5 passing.

- [ ] **Step 6: 写 observed-state-dao 测试**

Create `apps/gateway/test/db/observed-state-dao.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { makeObservedStateDao } from '../../src/db/observed-state-dao.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const USER_ID = '6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f';

function fakeSb() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  let stored: any = null;
  const ctx: any = {
    upsert: (row: any) => { calls.push({ op: 'upsert', args: [row] }); stored = row; return ctx; },
    select: () => { calls.push({ op: 'select', args: [] }); return ctx; },
    eq:     (k: string, v: any) => { calls.push({ op: 'eq', args: [k, v] }); return ctx; },
    maybeSingle: () => Promise.resolve({ data: stored, error: null }),
    then: (cb: any) => Promise.resolve({ data: null, error: null }).then(cb),
  };
  const mock = { from: () => ctx } as unknown as SupabaseClient;
  return { mock, calls };
}

describe('ObservedStateDao', () => {
  it('upsert writes a row keyed by user_id', async () => {
    const { mock, calls } = fakeSb();
    const dao = makeObservedStateDao(mock);
    await dao.upsert({
      user_id: USER_ID,
      observed_entitlements: ['cloud'],
      observed_token_version: 3,
    });
    const upsert = calls.find(c => c.op === 'upsert');
    expect(upsert).toBeDefined();
    const [row] = upsert!.args as any[];
    expect(row.user_id).toBe(USER_ID);
    expect(row.observed_entitlements).toEqual(['cloud']);
    expect(row.observed_token_version).toBe(3);
    expect(row.reported_at).toBeDefined();
  });

  it('get returns the previously upserted row', async () => {
    const { mock } = fakeSb();
    const dao = makeObservedStateDao(mock);
    await dao.upsert({
      user_id: USER_ID,
      observed_entitlements: ['cloud'],
      observed_token_version: 2,
    });
    const got = await dao.get(USER_ID);
    expect(got).toMatchObject({
      observed_entitlements: ['cloud'],
      observed_token_version: 2,
    });
  });
});
```

- [ ] **Step 7: 实现 observed-state-dao**

Create `apps/gateway/src/db/observed-state-dao.ts`:

```typescript
import type { SupabaseClient } from '@supabase/supabase-js';

export interface ObservedStateRow {
  user_id: string;
  observed_entitlements: string[];
  observed_token_version: number;
  reported_at?: string;
}

export interface ObservedStateDao {
  upsert(input: Omit<ObservedStateRow, 'reported_at'>): Promise<void>;
  get(userId: string): Promise<ObservedStateRow | null>;
}

export const makeObservedStateDao = (sb: SupabaseClient): ObservedStateDao => {
  return {
    async upsert(input) {
      const { error } = await sb.from('container_observed_state').upsert(
        {
          user_id: input.user_id,
          observed_entitlements: input.observed_entitlements,
          observed_token_version: input.observed_token_version,
          reported_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' },
      );
      if (error) throw new Error(`observed upsert: ${error.message}`);
    },

    async get(userId) {
      const { data, error } = await sb
        .from('container_observed_state')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw new Error(`observed get: ${error.message}`);
      return data as ObservedStateRow | null;
    },
  };
};
```

- [ ] **Step 8: 跑所有 db 测试看 pass**

```bash
pnpm --filter @lingxi/gateway test -- db
```
Expected: 全绿 (entitlements 5 + observed 2 = 7 new)。

- [ ] **Step 9: Lint + Commit**

```bash
pnpm --filter @lingxi/gateway run lint
git add apps/gateway/src/db/entitlements-dao.ts \
        apps/gateway/test/db/entitlements-dao.test.ts \
        apps/gateway/src/db/observed-state-dao.ts \
        apps/gateway/test/db/observed-state-dao.test.ts
git commit -m "feat(gateway): entitlements + observed-state DAOs"
```

---

## Task 6: `/api/me/entitlements` (GET) + `/api/me/observed-entitlements` (POST)

**Files:**
- Create: `apps/gateway/src/api/me-entitlements.ts`
- Create: `apps/gateway/test/api/me-entitlements.test.ts`

容器侧调的两个端点：拉 desired / 上报 observed。两个都用 container-token middleware。

- [ ] **Step 1: 写失败测试**

Create `apps/gateway/test/api/me-entitlements.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { buildMeEntitlementsRouter } from '../../src/api/me-entitlements.js';
import { signLaifuUserToken } from '../../src/lib/gateway-token.js';

const SECRET = 'test-secret-1234567890';
const USER_ID = '6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f';

function makeApp(opts: {
  listActive: (userId: string) => Promise<string[]>;
  upsertObserved: (input: any) => Promise<void>;
  getTokenVersion: (userId: string) => Promise<number | null>;
}) {
  const app = express();
  app.use(express.json());
  app.use(buildMeEntitlementsRouter({
    secret: SECRET,
    entitlements: { listActive: opts.listActive, getTokenVersion: opts.getTokenVersion } as any,
    observedState: { upsert: opts.upsertObserved } as any,
  }));
  return app;
}

describe('GET /api/me/entitlements', () => {
  it('returns active entitlements + token_version for the authenticated container', async () => {
    const app = makeApp({
      listActive: vi.fn().mockResolvedValue(['cloud']),
      upsertObserved: vi.fn(),
      getTokenVersion: vi.fn().mockResolvedValue(2),
    });
    const token = signLaifuUserToken({ userId: USER_ID, tokenVersion: 2, secret: SECRET });
    const res = await request(app)
      .get('/api/me/entitlements')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ entitlements: ['cloud'], token_version: 2 });
  });

  it('401 without token', async () => {
    const app = makeApp({
      listActive: vi.fn(),
      upsertObserved: vi.fn(),
      getTokenVersion: vi.fn(),
    });
    const res = await request(app).get('/api/me/entitlements');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/me/observed-entitlements', () => {
  it('writes observed state for the authenticated container', async () => {
    const upsert = vi.fn().mockResolvedValue(undefined);
    const app = makeApp({
      listActive: vi.fn().mockResolvedValue(['cloud']),
      upsertObserved: upsert,
      getTokenVersion: vi.fn().mockResolvedValue(0),
    });
    const token = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: SECRET });
    const res = await request(app)
      .post('/api/me/observed-entitlements')
      .set('Authorization', `Bearer ${token}`)
      .send({ observed: ['cloud'], token_version: 0 });
    expect(res.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith({
      user_id: USER_ID,
      observed_entitlements: ['cloud'],
      observed_token_version: 0,
    });
  });

  it('400 on missing fields', async () => {
    const app = makeApp({
      listActive: vi.fn(),
      upsertObserved: vi.fn(),
      getTokenVersion: vi.fn().mockResolvedValue(0),
    });
    const token = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: SECRET });
    const res = await request(app)
      .post('/api/me/observed-entitlements')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: 跑测试看 fail**

```bash
pnpm --filter @lingxi/gateway test -- me-entitlements
```

- [ ] **Step 3: 实现 router**

Create `apps/gateway/src/api/me-entitlements.ts`:

```typescript
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { makeContainerTokenMiddleware } from '../auth/container-token.js';
import type { EntitlementsDao } from '../db/entitlements-dao.js';
import type { ObservedStateDao } from '../db/observed-state-dao.js';
import type { EntitlementsList } from '@lingxi/shared';

export interface MeEntitlementsRouterDeps {
  secret: string;
  entitlements: EntitlementsDao;
  observedState: ObservedStateDao;
}

export const buildMeEntitlementsRouter = (deps: MeEntitlementsRouterDeps): RouterType => {
  const router = Router();
  const containerAuth = makeContainerTokenMiddleware({
    secret: deps.secret,
    tokenVersionFetcher: (userId) => deps.entitlements.getTokenVersion(userId),
  });

  router.get('/api/me/entitlements', containerAuth, async (req: Request, res: Response) => {
    const userId = req.user_id!;
    try {
      const features = await deps.entitlements.listActive(userId);
      const tokenVersion = await deps.entitlements.getTokenVersion(userId);
      const body: EntitlementsList = {
        entitlements: features,
        token_version: tokenVersion ?? 0,
      };
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: 'internal', message: String(err) });
    }
  });

  router.post('/api/me/observed-entitlements', containerAuth, async (req: Request, res: Response) => {
    const userId = req.user_id!;
    const body = req.body as { observed?: unknown; token_version?: unknown };
    if (!Array.isArray(body.observed) || typeof body.token_version !== 'number') {
      res.status(400).json({ error: 'observed (string[]) and token_version (number) required' });
      return;
    }
    try {
      await deps.observedState.upsert({
        user_id: userId,
        observed_entitlements: body.observed as string[],
        observed_token_version: body.token_version,
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: 'internal', message: String(err) });
    }
  });

  return router;
};
```

- [ ] **Step 4: 跑测试看 pass + lint + commit**

```bash
pnpm --filter @lingxi/gateway test -- me-entitlements
pnpm --filter @lingxi/gateway run lint
git add apps/gateway/src/api/me-entitlements.ts apps/gateway/test/api/me-entitlements.test.ts
git commit -m "feat(gateway): /api/me/entitlements + /api/me/observed-entitlements"
```

---

## Task 7: `/api/auth/refresh-token` (with grace)

**Files:**
- Create: `apps/gateway/src/api/auth-refresh.ts`
- Create: `apps/gateway/test/api/auth-refresh.test.ts`

容器启动时如果 token 距 exp <7 天 (或已过期 ≤7d) → 调这里拿 fresh token。Grace 期 = 7 天（spec §四）。

逻辑：
1. 读 `Authorization: Bearer <token>`
2. 用 `verifyLaifuUserToken` with `allowExpiredWithinDays=7` 验证 + 比对当前 token_version
3. 用当前 token_version 重新签 90d token 返回

- [ ] **Step 1: 写失败测试**

Create `apps/gateway/test/api/auth-refresh.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { buildAuthRefreshRouter } from '../../src/api/auth-refresh.js';
import { signLaifuUserToken, verifyLaifuUserToken } from '../../src/lib/gateway-token.js';

const SECRET = 'test-secret-1234567890';
const USER_ID = '6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f';

function makeApp(getTokenVersion: (uid: string) => Promise<number | null>) {
  const app = express();
  app.use(express.json());
  app.use(buildAuthRefreshRouter({ secret: SECRET, getTokenVersion }));
  return app;
}

describe('POST /api/auth/refresh-token', () => {
  it('returns a fresh token when current token is valid', async () => {
    const app = makeApp(vi.fn().mockResolvedValue(0));
    const old = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: SECRET });
    const res = await request(app)
      .post('/api/auth/refresh-token')
      .set('Authorization', `Bearer ${old}`)
      .send({});
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.expires_at).toMatch(/T.*Z/);
    const verified = verifyLaifuUserToken(res.body.token, {
      expectedTokenVersion: 0,
      secret: SECRET,
    });
    expect(verified.userId).toBe(USER_ID);
  });

  it('accepts a token expired within 7 days (grace)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const old = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: SECRET });
    vi.setSystemTime(new Date('2026-04-06T00:00:00Z')); // 95 days later — 5d past exp

    const app = makeApp(vi.fn().mockResolvedValue(0));
    const res = await request(app)
      .post('/api/auth/refresh-token')
      .set('Authorization', `Bearer ${old}`)
      .send({});
    expect(res.status).toBe(200);
    vi.useRealTimers();
  });

  it('rejects a token expired >7 days', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const old = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: SECRET });
    vi.setSystemTime(new Date('2026-04-09T00:00:00Z')); // 98 days later — 8d past exp

    const app = makeApp(vi.fn().mockResolvedValue(0));
    const res = await request(app)
      .post('/api/auth/refresh-token')
      .set('Authorization', `Bearer ${old}`)
      .send({});
    expect(res.status).toBe(401);
    vi.useRealTimers();
  });

  it('rejects when token_version was bumped (revoked) — even within grace', async () => {
    const app = makeApp(vi.fn().mockResolvedValue(1)); // DB version is 1
    const old = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: SECRET }); // token has 0
    const res = await request(app)
      .post('/api/auth/refresh-token')
      .set('Authorization', `Bearer ${old}`)
      .send({});
    expect(res.status).toBe(401);
  });

  it('401 without Authorization header', async () => {
    const app = makeApp(vi.fn());
    const res = await request(app).post('/api/auth/refresh-token').send({});
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: 跑测试看 fail**

```bash
pnpm --filter @lingxi/gateway test -- auth-refresh
```

- [ ] **Step 3: 实现**

Create `apps/gateway/src/api/auth-refresh.ts`:

```typescript
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import {
  signLaifuUserToken,
  verifyLaifuUserToken,
  TokenExpiredError,
  TokenInvalidError,
  TokenVersionMismatchError,
} from '../lib/gateway-token.js';
import type { RefreshTokenResponse } from '@lingxi/shared';

const GRACE_DAYS = 7;
const LIFETIME_SECONDS = 90 * 24 * 3600;

export interface AuthRefreshDeps {
  secret: string;
  getTokenVersion: (userId: string) => Promise<number | null>;
}

interface PeekedPayload {
  user_id: string;
  token_version: number;
}

function peekJwt(token: string): PeekedPayload {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('not a jwt');
  const raw = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  if (typeof raw.user_id !== 'string' || typeof raw.token_version !== 'number') {
    throw new Error('payload shape invalid');
  }
  return { user_id: raw.user_id, token_version: raw.token_version };
}

export const buildAuthRefreshRouter = (deps: AuthRefreshDeps): RouterType => {
  const router = Router();

  router.post('/api/auth/refresh-token', async (req: Request, res: Response) => {
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) {
      res.status(401).json({ error: 'missing or non-Bearer Authorization header' });
      return;
    }
    const token = header.slice(7);

    let userId: string;
    try {
      userId = peekJwt(token).user_id;
    } catch {
      res.status(401).json({ error: 'invalid token' });
      return;
    }

    const currentVersion = await deps.getTokenVersion(userId);
    if (currentVersion === null) {
      res.status(401).json({ error: 'unknown user' });
      return;
    }

    try {
      verifyLaifuUserToken(token, {
        expectedTokenVersion: currentVersion,
        secret: deps.secret,
        allowExpiredWithinDays: GRACE_DAYS,
      });
    } catch (err) {
      if (err instanceof TokenVersionMismatchError) {
        res.status(401).json({ error: 'token revoked (version mismatch)' });
        return;
      }
      if (err instanceof TokenExpiredError) {
        res.status(401).json({ error: 'token expired beyond grace' });
        return;
      }
      if (err instanceof TokenInvalidError) {
        res.status(401).json({ error: 'invalid token' });
        return;
      }
      res.status(500).json({ error: 'internal' });
      return;
    }

    const newToken = signLaifuUserToken({
      userId,
      tokenVersion: currentVersion,
      secret: deps.secret,
    });
    const expiresAt = new Date((Math.floor(Date.now() / 1000) + LIFETIME_SECONDS) * 1000).toISOString();
    const body: RefreshTokenResponse = { token: newToken, expires_at: expiresAt };
    res.json(body);
  });

  return router;
};
```

- [ ] **Step 4: 跑测试看 pass + commit**

```bash
pnpm --filter @lingxi/gateway test -- auth-refresh
pnpm --filter @lingxi/gateway run lint
git add apps/gateway/src/api/auth-refresh.ts apps/gateway/test/api/auth-refresh.test.ts
git commit -m "feat(gateway): /api/auth/refresh-token with 7d grace period"
```

---

## Task 8: `/api/entitlements/cloud/{enable,disable}`

**Files:**
- Create: `apps/gateway/src/api/entitlements.ts`
- Create: `apps/gateway/test/api/entitlements.test.ts`

业务编排：
1. 调 DAO `enable`/`disable`
2. 如果 `changed=true` → bump token_version → 触发 ACA restart
3. 返回当前 active entitlements

restart trigger 由 caller 注入（azure provisioner 实现真重启，local provisioner mock 一下）。

- [ ] **Step 1: 写失败测试**

Create `apps/gateway/test/api/entitlements.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { buildEntitlementsRouter } from '../../src/api/entitlements.js';
import type { RequestHandler } from 'express';

const USER_ID = '6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f';

function mockSession(): RequestHandler {
  return (req, _res, next) => { (req as any).session = { user_id: USER_ID }; next(); };
}

function makeApp(deps: {
  enable: ReturnType<typeof vi.fn>;
  disable: ReturnType<typeof vi.fn>;
  listActive: ReturnType<typeof vi.fn>;
  bumpTokenVersion: ReturnType<typeof vi.fn>;
  restartContainer: ReturnType<typeof vi.fn>;
  signTokenAndInject: ReturnType<typeof vi.fn>;
}) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(buildEntitlementsRouter({
    entitlements: {
      enable: deps.enable, disable: deps.disable, listActive: deps.listActive,
      bumpTokenVersion: deps.bumpTokenVersion,
      getTokenVersion: vi.fn(),
    } as any,
    restartContainer: deps.restartContainer,
    signTokenAndInject: deps.signTokenAndInject,
    sessionMw: mockSession(),
  }));
  return app;
}

describe('POST /api/entitlements/cloud/enable', () => {
  it('happy path: enable changes state → bump version → sign new token → restart container', async () => {
    const enable = vi.fn().mockResolvedValue({ changed: true });
    const listActive = vi.fn().mockResolvedValue(['cloud']);
    const bumpTokenVersion = vi.fn().mockResolvedValue(1);
    const restartContainer = vi.fn().mockResolvedValue(undefined);
    const signTokenAndInject = vi.fn().mockResolvedValue(undefined);

    const app = makeApp({
      enable, disable: vi.fn(), listActive, bumpTokenVersion,
      restartContainer, signTokenAndInject,
    });
    const res = await request(app).post('/api/entitlements/cloud/enable');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, entitlements: ['cloud'], changed: true });

    expect(enable).toHaveBeenCalledWith(USER_ID, 'cloud');
    expect(bumpTokenVersion).toHaveBeenCalledWith(USER_ID);
    expect(signTokenAndInject).toHaveBeenCalledWith(USER_ID, 1);
    expect(restartContainer).toHaveBeenCalledWith(USER_ID);
  });

  it('idempotent: already enabled → no bump / no restart', async () => {
    const enable = vi.fn().mockResolvedValue({ changed: false });
    const listActive = vi.fn().mockResolvedValue(['cloud']);
    const bumpTokenVersion = vi.fn();
    const restartContainer = vi.fn();

    const app = makeApp({
      enable, disable: vi.fn(), listActive, bumpTokenVersion,
      restartContainer, signTokenAndInject: vi.fn(),
    });
    const res = await request(app).post('/api/entitlements/cloud/enable');

    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    expect(bumpTokenVersion).not.toHaveBeenCalled();
    expect(restartContainer).not.toHaveBeenCalled();
  });
});

describe('POST /api/entitlements/cloud/disable', () => {
  it('disable changes state → bump version → restart, but does NOT delete blob data', async () => {
    const disable = vi.fn().mockResolvedValue({ changed: true });
    const listActive = vi.fn().mockResolvedValue([]);
    const bumpTokenVersion = vi.fn().mockResolvedValue(2);
    const restartContainer = vi.fn().mockResolvedValue(undefined);

    const app = makeApp({
      enable: vi.fn(), disable, listActive, bumpTokenVersion,
      restartContainer, signTokenAndInject: vi.fn().mockResolvedValue(undefined),
    });
    const res = await request(app).post('/api/entitlements/cloud/disable');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, entitlements: [], changed: true });
    expect(disable).toHaveBeenCalledWith(USER_ID, 'cloud');
    expect(bumpTokenVersion).toHaveBeenCalled();
    expect(restartContainer).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试看 fail**

```bash
pnpm --filter @lingxi/gateway test -- entitlements
```

- [ ] **Step 3: 实现**

Create `apps/gateway/src/api/entitlements.ts`:

```typescript
import { Router, type Router as RouterType, type Request, type Response, type RequestHandler } from 'express';
import type { EntitlementsDao } from '../db/entitlements-dao.js';
import type { EntitlementChangeResponse } from '@lingxi/shared';

const FEATURE = 'cloud';

export interface EntitlementsRouterDeps {
  entitlements: EntitlementsDao;
  /** Trigger a container restart for the user (ACA restartRevision or local mock). */
  restartContainer: (userId: string) => Promise<void>;
  /**
   * Sign a new LAIFU_USER_TOKEN using the new token_version, and write it
   * to the container's env / secret store so the next start picks it up.
   * Implemented in Task 9 (provisioning).
   */
  signTokenAndInject: (userId: string, tokenVersion: number) => Promise<void>;
  sessionMw: RequestHandler;
}

export const buildEntitlementsRouter = (deps: EntitlementsRouterDeps): RouterType => {
  const router = Router();

  router.post('/api/entitlements/cloud/enable', deps.sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    try {
      const { changed } = await deps.entitlements.enable(userId, FEATURE);
      if (changed) {
        const newVersion = await deps.entitlements.bumpTokenVersion(userId);
        await deps.signTokenAndInject(userId, newVersion);
        // Fire-and-forget the restart so the API returns fast.
        // The front-end polls /api/status to know when the container actually came back up.
        deps.restartContainer(userId).catch((err) => {
          console.error(`[entitlements] restart failed for ${userId}:`, err);
        });
      }
      const active = await deps.entitlements.listActive(userId);
      const body: EntitlementChangeResponse = { ok: true, entitlements: active, changed };
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: 'internal', message: String(err) });
    }
  });

  router.post('/api/entitlements/cloud/disable', deps.sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    try {
      const { changed } = await deps.entitlements.disable(userId, FEATURE);
      if (changed) {
        const newVersion = await deps.entitlements.bumpTokenVersion(userId);
        await deps.signTokenAndInject(userId, newVersion);
        deps.restartContainer(userId).catch((err) => {
          console.error(`[entitlements] restart failed for ${userId}:`, err);
        });
      }
      const active = await deps.entitlements.listActive(userId);
      const body: EntitlementChangeResponse = { ok: true, entitlements: active, changed };
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: 'internal', message: String(err) });
    }
  });

  return router;
};
```

- [ ] **Step 4: 跑测试看 pass + commit**

```bash
pnpm --filter @lingxi/gateway test -- entitlements
pnpm --filter @lingxi/gateway run lint
git add apps/gateway/src/api/entitlements.ts apps/gateway/test/api/entitlements.test.ts
git commit -m "feat(gateway): /api/entitlements/cloud/{enable,disable}"
```

---

## Task 9: `/api/status` 扩展 + 新增 status.test.ts

**Files:**
- Modify: `apps/gateway/src/api/status.ts`
- Create: `apps/gateway/test/api/status.test.ts`

把 desired entitlements + observed entitlements + token_version 加进 status 响应。需要新依赖：entitlementsDao 和 observedStateDao。

- [ ] **Step 1: 读现有 status.ts**

复习 `apps/gateway/src/api/status.ts`，了解 buildStatusRouter 当前签名。

- [ ] **Step 2: 写测试（之前没单测，新加）**

Create `apps/gateway/test/api/status.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { buildStatusRouter } from '../../src/api/status.js';
import type { RequestHandler } from 'express';

const USER_ID = '6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f';

function mockSession(): RequestHandler {
  return (req, _res, next) => { (req as any).session = { user_id: USER_ID }; next(); };
}

function makeApp(opts: {
  containerRow: any;
  desired: string[];
  observed: { observed_entitlements: string[]; observed_token_version: number } | null;
  tokenVersion: number;
}) {
  const app = express();
  app.use(express.json());
  const fakeCache = { get: () => opts.containerRow } as any;
  app.use(buildStatusRouter(
    fakeCache,
    mockSession(),
    { listActive: () => Promise.resolve(opts.desired), getTokenVersion: () => Promise.resolve(opts.tokenVersion) } as any,
    { get: () => Promise.resolve(opts.observed) } as any,
  ));
  return app;
}

describe('GET /api/status', () => {
  it('returns provisioning fields + entitlements + observed', async () => {
    const app = makeApp({
      containerRow: {
        status: 'ready', provisioning_step: '...', progress_pct: 100,
        error_message: null,
      },
      desired: ['cloud'],
      observed: { observed_entitlements: ['cloud'], observed_token_version: 1 },
      tokenVersion: 1,
    });
    const res = await request(app).get('/api/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ready',
      entitlements_desired: ['cloud'],
      entitlements_observed: ['cloud'],
      container_token_version: 1,
    });
  });

  it('observed defaults to [] when container never reported', async () => {
    const app = makeApp({
      containerRow: {
        status: 'ready', provisioning_step: null, progress_pct: 100, error_message: null,
      },
      desired: ['cloud'],
      observed: null,
      tokenVersion: 0,
    });
    const res = await request(app).get('/api/status');
    expect(res.body.entitlements_observed).toEqual([]);
  });

  it('404 when no container mapping exists', async () => {
    const app = makeApp({
      containerRow: null,
      desired: [], observed: null, tokenVersion: 0,
    });
    const res = await request(app).get('/api/status');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 3: 改 status.ts**

Modify `apps/gateway/src/api/status.ts` — 整体替换为：

```typescript
import { Router, type Request, type Response, type Router as RouterType, type RequestHandler } from 'express';
import type { ContainerMappingCache } from '../db/cache.js';
import type { EntitlementsDao } from '../db/entitlements-dao.js';
import type { ObservedStateDao } from '../db/observed-state-dao.js';
import type { StatusResponse } from '@lingxi/shared';

export const buildStatusRouter = (
  cacheOrGetter: ContainerMappingCache | (() => ContainerMappingCache),
  sessionMw: RequestHandler,
  entitlements: Pick<EntitlementsDao, 'listActive' | 'getTokenVersion'>,
  observedState: Pick<ObservedStateDao, 'get'>,
): RouterType => {
  const router = Router();
  const getCache = (): ContainerMappingCache =>
    typeof cacheOrGetter === 'function' ? cacheOrGetter() : cacheOrGetter;

  router.get('/api/status', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const row = getCache().get(userId);
    if (!row) {
      res.status(404).json({ error: 'no container mapping' });
      return;
    }

    const [desired, observed, tokenVersion] = await Promise.all([
      entitlements.listActive(userId),
      observedState.get(userId),
      entitlements.getTokenVersion(userId),
    ]);

    const body: StatusResponse = {
      status: row.status,
      provisioning_step: row.provisioning_step,
      progress_pct: row.progress_pct,
      error_message: row.error_message,
      entitlements_desired: desired,
      entitlements_observed: observed?.observed_entitlements ?? [],
      container_token_version: tokenVersion ?? 0,
    };
    res.json(body);
  });

  return router;
};
```

- [ ] **Step 4: 跑 status 测试 + 全部测试 + lint**

```bash
pnpm --filter @lingxi/gateway test -- status
pnpm --filter @lingxi/gateway test
pnpm --filter @lingxi/gateway run lint
```
Expected: status 3/3, 全套全绿。

- [ ] **Step 5: 在 Task 2 加了 `?` 的话现在去掉**

如果 Task 2 把 StatusResponse 新字段设了 `?`（optional），现在 status.ts 都返回了，去掉 `?`：

Edit `packages/shared/src/contracts.ts` — 把 `entitlements_desired?: string[]` 去掉 `?`，三个新字段都改成 required。Tasks 编译应仍通过，因为 gateway 现在都返回了。

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/api/status.ts \
        apps/gateway/test/api/status.test.ts \
        packages/shared/src/contracts.ts
git commit -m "feat(gateway): /api/status returns entitlements + observed + token_version"
```

---

## Task 10: Provisioning — Inject LAIFU_USER_TOKEN + Restart helper

**Files:**
- Modify: `apps/gateway/src/provisioning/azure.ts`
- Modify: `apps/gateway/src/provisioning/local.ts`

加两个 helper export：
- `signTokenAndInject(userId, tokenVersion)` — sign JWT 并写到容器的 env / secret store
- `restartContainerApp(userId)` — 触发 ACA restartRevision (azure) 或 noop (local)

Azure 上注入 token 到 Container App 的 env：用 `containerApps.beginUpdate` 改 `properties.template.containers[].env` 数组，加 `{ name: 'LAIFU_USER_TOKEN', value: jwt }` 或用 secret reference。Restart 用 `revisionsClient.restartRevision`。

Local provisioner (开发用) 把 token 写到环境变量 / 文件，让 docker-compose 重启时读到 —— 但 local 容器是怎么起的？看 `docker/hermes/` + `scripts/dev-hermes.sh`。可能要协调 dev 流程。**先 mock：local provisioner 的 helper 只 console.log 一下，不真注入；P1 的 e2e 测试在 azure 模式下做。**

实际细节比较多，**留给 subagent 实施时根据现有 azure.ts 真实代码决定**。

- [ ] **Step 1: 阅读现有 `apps/gateway/src/provisioning/azure.ts`**

通读，理解现有 createUserContainer / provisionContainer 流程，找出修改注入新 env 的方式。

- [ ] **Step 2: 加 helper**

In `apps/gateway/src/provisioning/azure.ts`, append exports:

```typescript
import { signLaifuUserToken } from '../lib/gateway-token.js';

/**
 * 给指定用户的 Container App 注入新的 LAIFU_USER_TOKEN。
 * 调用方应已经 bump 过 token_version；本函数只负责 sign + write。
 */
export const signTokenAndInjectAzure = async (
  userId: string,
  tokenVersion: number,
): Promise<void> => {
  const token = signLaifuUserToken({
    userId,
    tokenVersion,
    secret: config.auth.gatewaySecret,
  });
  const appName = `hermes-${userId}`;
  // 用 update 覆盖该 container 的 env 数组里 LAIFU_USER_TOKEN 这一项
  const current = await getContainerApps().containerApps.get(
    config.azure.resourceGroup, appName,
  );
  const containers = current.template?.containers ?? [];
  if (containers.length === 0) {
    throw new Error(`signTokenAndInjectAzure: no containers in ${appName}`);
  }
  const env = (containers[0]!.env ?? []).filter((e: { name?: string }) => e.name !== 'LAIFU_USER_TOKEN');
  env.push({ name: 'LAIFU_USER_TOKEN', value: token });
  containers[0]!.env = env;
  await getContainerApps().containerApps.beginUpdateAndWait(
    config.azure.resourceGroup, appName,
    { template: { containers } as any },
  );
};

/**
 * 触发 Container App 重启 (ACA restartRevision)。
 * 拉新 env 起容器,entrypoint 会读 LAIFU_USER_TOKEN + 拉 entitlements + 软链 skill。
 */
export const restartContainerAppAzure = async (userId: string): Promise<void> => {
  const appName = `hermes-${userId}`;
  const app = await getContainerApps().containerApps.get(
    config.azure.resourceGroup, appName,
  );
  const latestRevisionName = app.latestRevisionName;
  if (!latestRevisionName) {
    throw new Error(`restartContainerAppAzure: no revision for ${appName}`);
  }
  await getContainerApps().containerAppsRevisions.restartRevision(
    config.azure.resourceGroup, appName, latestRevisionName,
  );
};
```

In `apps/gateway/src/provisioning/local.ts`, append:

```typescript
import { signLaifuUserToken } from '../lib/gateway-token.js';
import { config } from '../config.js';

export const signTokenAndInjectLocal = async (
  userId: string,
  tokenVersion: number,
): Promise<void> => {
  const token = signLaifuUserToken({
    userId, tokenVersion, secret: config.auth.gatewaySecret,
  });
  console.log(`[provisioning/local] would inject LAIFU_USER_TOKEN for ${userId} (version=${tokenVersion}, len=${token.length})`);
  // P1 不做真注入 — local 容器需要手动重启,token 通过 /api/me/entitlements + /api/auth/refresh-token 流程自然刷新。
};

export const restartContainerAppLocal = async (userId: string): Promise<void> => {
  console.log(`[provisioning/local] would restart container for ${userId}`);
  // dev 流程靠 pnpm dev:hermes,无法远程触发重启。开发者手动重启。
};
```

- [ ] **Step 3: Lint**

```bash
pnpm --filter @lingxi/gateway run lint
```

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/src/provisioning/azure.ts apps/gateway/src/provisioning/local.ts
git commit -m "feat(provisioning): signTokenAndInject + restartContainerApp helpers"
```

---

## Task 11: 在 `index.ts` 把新路由都装上

**Files:**
- Modify: `apps/gateway/src/index.ts`

实例化 DAO + 装两个新路由 + 把 enable/disable 路由的 signTokenAndInject / restartContainer 依赖传进去。

- [ ] **Step 1: 改 `apps/gateway/src/index.ts`**

通读现有 `createApp(...)`，仿照 `buildPurchaseRouter` / `buildThreadsRouter` 的注入风格加上：

```typescript
import { makeEntitlementsDao } from './db/entitlements-dao.js';
import { makeObservedStateDao } from './db/observed-state-dao.js';
import { buildEntitlementsRouter } from './api/entitlements.js';
import { buildMeEntitlementsRouter } from './api/me-entitlements.js';
import { buildAuthRefreshRouter } from './api/auth-refresh.js';
import {
  signTokenAndInjectAzure,
  restartContainerAppAzure,
} from './provisioning/azure.js';
import {
  signTokenAndInjectLocal,
  restartContainerAppLocal,
} from './provisioning/local.js';
```

In `createApp`, after `sbResolved` is set, add:

```typescript
  if (sbResolved) {
    const entitlementsDao = makeEntitlementsDao(sbResolved);
    const observedStateDao = makeObservedStateDao(sbResolved);

    // 根据 provisioner 选择真实 / mock 的 token+restart helper
    const signAndInject = config.provisioner === 'azure'
      ? signTokenAndInjectAzure
      : signTokenAndInjectLocal;
    const restartContainer = config.provisioner === 'azure'
      ? restartContainerAppAzure
      : restartContainerAppLocal;

    app.use(buildEntitlementsRouter({
      entitlements: entitlementsDao,
      restartContainer,
      signTokenAndInject: signAndInject,
      sessionMw,
    }));

    app.use(buildMeEntitlementsRouter({
      secret: config.auth.gatewaySecret,
      entitlements: entitlementsDao,
      observedState: observedStateDao,
    }));

    app.use(buildAuthRefreshRouter({
      secret: config.auth.gatewaySecret,
      getTokenVersion: (uid) => entitlementsDao.getTokenVersion(uid),
    }));

    // ... 已有 routers
  }
```

同时改 status router 的实例化以传入新 deps:

```typescript
  app.use(buildStatusRouter(getCache, sessionMw, entitlementsDao, observedStateDao));
```

注意 `entitlementsDao` 需要在 sbResolved 那一支里实例化才有；`buildStatusRouter` 当前在外层用 `getCache` lazy 注入。把它也挪进 `if (sbResolved)` 块内，避免空 sb 时 dao 无值。

- [ ] **Step 2: Lint + 全测试**

```bash
pnpm --filter @lingxi/gateway run lint
pnpm --filter @lingxi/gateway test
```
Expected: 全绿。

- [ ] **Step 3: dev 启动验证**

```bash
cd /Users/yanjiayi/workspace/laifu && pnpm dev:gateway
```
后台跑 10s 检查 startup log 没报错；调一下：

```bash
curl http://localhost:9000/healthz
```
Expected: `{"ok":true,...}`. 然后 Ctrl-C 停掉。

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/src/index.ts
git commit -m "feat(gateway): wire entitlements + auth-refresh + me routes"
```

---

## Task 12: 容器 entrypoint — 拉 entitlements / 软链 / 上报

**Files:**
- Modify: `docker/hermes/entrypoint.sh`
- Modify: `docker/hermes/Dockerfile`
- Create: `docker/hermes/skills/cloud_publish/SKILL.md` (placeholder)

容器启动时新增 step 5-7:
- Step 5: token 续签（如果剩余时间 <7d）
- Step 6: 拉 desired entitlements，按列表软链 `/opt/hermes-skills/<feature>/` 到 `~/.hermes/skills/<feature>`
- Step 7: 上报 observed

环境变量预期：`LAIFU_USER_TOKEN` (gateway 注入)、`GATEWAY_BASE_URL` (gateway 内部域名)。

容器需要 `curl` 和 `jq` —— Dockerfile 已有 curl，需要加 `jq`。

`/opt/hermes-skills/cloud_publish/` 现在是空目录会让软链时找不到目标；P1 加一个占位 SKILL.md，P3 替换为真实 skill。

- [ ] **Step 1: 改 Dockerfile**

In `docker/hermes/Dockerfile`, find the apt-get install line and add `jq`:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates build-essential \
    nodejs npm ripgrep sudo jq \
    && rm -rf /var/lib/apt/lists/*
```

In the same file, after the existing Hermes install but before `USER hermes`, add:

```dockerfile
# ============ Hermes skills 占位目录 ============
# P1 阶段为 cloud_publish 留一个能软链的目标 (空 SKILL.md 占位)。
# P3 会替换 SKILL.md + 加 cloud_publish CLI 实现。
COPY --chown=hermes:hermes docker/hermes/skills/ /opt/hermes-skills/
```

实际 COPY 路径要参考 Dockerfile build context；如果 build context 是 `docker/hermes/`，路径应是 `skills/` 不是 `docker/hermes/skills/`。检查 `scripts/dev-hermes.sh` 或 CI 怎么 build 的。

- [ ] **Step 2: 创建占位 skill 文件**

```bash
mkdir -p /Users/yanjiayi/workspace/laifu/docker/hermes/skills/cloud_publish
```

Create `docker/hermes/skills/cloud_publish/SKILL.md`:

```markdown
# cloud_publish (P1 placeholder)

This file is a placeholder so `entrypoint.sh` can symlink
`/opt/hermes-skills/cloud_publish` → `~/.hermes/skills/cloud_publish` without
the target being empty. The actual `cloud-publish` CLI + skill description
land in P3.
```

- [ ] **Step 3: 改 entrypoint.sh**

In `docker/hermes/entrypoint.sh`, **before** the final `exec "$@"` line, insert these steps. The diff is large—replace the file from `set -e` down. Full new file:

```bash
#!/bin/bash
# entrypoint.sh （v3：加 entitlement / token 续签 / observed 上报）
#
# 职责：
#   1. 首次启动：从 seed 目录初始化空的 home volume
#   2. 旧 volume 迁移：legacy config.yaml / 老 Hermes 源码 / 老 shim 清理
#   3. P1: 容器 ↔ gateway 控制面闭环
#      a. 续签 LAIFU_USER_TOKEN（如果距 exp <7d）
#      b. 拉 desired entitlements (GET /api/me/entitlements)
#      c. 按列表软链 /opt/hermes-skills/<feature> → ~/.hermes/skills/<feature>
#      d. 上报 observed (POST /api/me/observed-entitlements)
#   4. 启动 hermes server
#
# 必需环境变量 (gateway provisioning 注入):
#   LAIFU_USER_TOKEN         90d JWT, payload 含 user_id + token_version
#   GATEWAY_BASE_URL         e.g. https://gateway.lingxi.internal
#                            本地 dev 时通过 docker-compose / dev-hermes.sh 传 http://host.docker.internal:9000
#
# 可选:
#   OPENAI_API_KEY / ANTHROPIC_API_KEY  LLM 凭据 (Hermes 直接用)

set -e

SEED=/home/hermes-seed
HOME_DIR=/home/hermes
CFG="$HOME_DIR/.hermes/config.yaml"
SEED_CFG="$SEED/.hermes/config.yaml"
SKILLS_DIR="$HOME_DIR/.hermes/skills"
SKILLS_SOURCE=/opt/hermes-skills
TOKEN_FILE="$HOME_DIR/.hermes/.laifu_user_token"

# ============ Step 1: seed 初始化 ============
if [ ! -f "$HOME_DIR/.initialized" ]; then
  echo "[entrypoint] first boot — seeding $HOME_DIR from $SEED"
  cp -a "$SEED/." "$HOME_DIR/" 2>/dev/null || true
  touch "$HOME_DIR/.initialized"
  echo "[entrypoint] seed complete"
else
  echo "[entrypoint] existing home detected, skipping seed"
fi

# ============ Step 2: 旧 config 迁移 ============
if [ -f "$CFG" ] && ! grep -q '\${OPENAI_API_KEY}' "$CFG"; then
  echo "[entrypoint] legacy config detected (plaintext key) — restoring template from seed"
  cp -f "$SEED_CFG" "$CFG"
fi

# ============ Step 3: 旧 Hermes 源码 / shim 迁移 ============
if [ -d "$HOME_DIR/.hermes/hermes-agent" ]; then
  echo "[entrypoint] legacy Hermes source detected — removing"
  rm -rf "$HOME_DIR/.hermes/hermes-agent"
fi
if [ -e "$HOME_DIR/.local/bin/hermes" ]; then
  echo "[entrypoint] legacy hermes shim detected — removing"
  rm -f "$HOME_DIR/.local/bin/hermes"
fi

# ============ Step 4: 健全性检查 ============
if [ -z "$OPENAI_API_KEY" ] && [ -z "$ANTHROPIC_API_KEY" ]; then
  echo "[entrypoint] WARN: no LLM API key set — Hermes will fail on first LLM call" >&2
fi

# ============ Step 5: LAIFU_USER_TOKEN 续签 (如果距 exp <7d) ============
if [ -z "$LAIFU_USER_TOKEN" ] || [ -z "$GATEWAY_BASE_URL" ]; then
  echo "[entrypoint] WARN: LAIFU_USER_TOKEN or GATEWAY_BASE_URL not set — skipping entitlement sync" >&2
  exec "$@"
fi

# 解 JWT payload 取 exp
JWT_PAYLOAD=$(echo "$LAIFU_USER_TOKEN" | cut -d. -f2)
# base64url decode (jq 不直接支持 base64url，先转换为 base64)
JWT_PAYLOAD_PADDED=$(echo "$JWT_PAYLOAD" | tr '_-' '/+' )
# pad 到 4 的倍数
PAD=$(( 4 - ${#JWT_PAYLOAD_PADDED} % 4 ))
[ $PAD -eq 4 ] && PAD=0
PADDING=$(printf "%${PAD}s" | tr ' ' '=')
TOKEN_EXP=$(echo "${JWT_PAYLOAD_PADDED}${PADDING}" | base64 -d 2>/dev/null | jq -r '.exp // 0')
NOW=$(date +%s)
SECS_LEFT=$(( TOKEN_EXP - NOW ))

echo "[entrypoint] LAIFU_USER_TOKEN expires in $(( SECS_LEFT / 86400 )) days"

if [ "$SECS_LEFT" -lt $(( 7 * 86400 )) ]; then
  echo "[entrypoint] token within 7d of exp — refreshing"
  REFRESH_RESP=$(curl -fsS -m 10 -X POST \
    -H "Authorization: Bearer $LAIFU_USER_TOKEN" \
    -H "Content-Type: application/json" \
    "$GATEWAY_BASE_URL/api/auth/refresh-token" || echo "")
  if [ -n "$REFRESH_RESP" ]; then
    NEW_TOKEN=$(echo "$REFRESH_RESP" | jq -r '.token // ""')
    if [ -n "$NEW_TOKEN" ] && [ "$NEW_TOKEN" != "null" ]; then
      LAIFU_USER_TOKEN="$NEW_TOKEN"
      echo "$NEW_TOKEN" > "$TOKEN_FILE"
      echo "[entrypoint] token refreshed (new exp ~90 days)"
    else
      echo "[entrypoint] WARN: refresh-token returned no token, keeping old" >&2
    fi
  else
    echo "[entrypoint] WARN: refresh-token request failed, keeping old" >&2
  fi
fi

# ============ Step 6: 拉 desired entitlements 并软链 skills ============
echo "[entrypoint] fetching desired entitlements"
ENT_JSON=$(curl -fsS -m 10 \
  -H "Authorization: Bearer $LAIFU_USER_TOKEN" \
  "$GATEWAY_BASE_URL/api/me/entitlements" 2>/dev/null || echo "")

if [ -z "$ENT_JSON" ]; then
  echo "[entrypoint] WARN: failed to fetch entitlements — skill sync skipped" >&2
  OBSERVED_TOKEN_VERSION=0
  DESIRED=""
else
  DESIRED=$(echo "$ENT_JSON" | jq -r '.entitlements[]?' 2>/dev/null || echo "")
  OBSERVED_TOKEN_VERSION=$(echo "$ENT_JSON" | jq -r '.token_version // 0' 2>/dev/null)
  echo "[entrypoint] desired entitlements: $(echo "$DESIRED" | tr '\n' ' ')"
fi

mkdir -p "$SKILLS_DIR"

# 先清掉已有的可能的 stale symlinks (避免 disable 后没清干净)
for link in "$SKILLS_DIR"/*; do
  [ -L "$link" ] || continue
  link_name=$(basename "$link")
  if ! echo "$DESIRED" | grep -qx "$link_name"; then
    echo "[entrypoint] removing stale skill: $link_name"
    rm -f "$link"
  fi
done

# 软链 desired 的 skill
OBSERVED_LIST=""
for feature in $DESIRED; do
  TARGET="$SKILLS_SOURCE/$feature"
  LINK="$SKILLS_DIR/$feature"
  if [ -d "$TARGET" ]; then
    ln -snf "$TARGET" "$LINK"
    echo "[entrypoint] linked skill: $feature"
    OBSERVED_LIST="$OBSERVED_LIST $feature"
  else
    echo "[entrypoint] WARN: skill $feature requested but not installed in image" >&2
  fi
done

# ============ Step 7: 上报 observed ============
# Build JSON array of observed features for the request body
OBSERVED_JSON=$(echo "$OBSERVED_LIST" | tr ' ' '\n' | grep -v '^$' | jq -R . | jq -s . || echo "[]")
REPORT_BODY=$(jq -n --argjson observed "$OBSERVED_JSON" --argjson tv "$OBSERVED_TOKEN_VERSION" \
  '{observed: $observed, token_version: $tv}')

echo "[entrypoint] reporting observed: $REPORT_BODY"
curl -fsS -m 10 -X POST \
  -H "Authorization: Bearer $LAIFU_USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$REPORT_BODY" \
  "$GATEWAY_BASE_URL/api/me/observed-entitlements" 2>&1 || \
  echo "[entrypoint] WARN: observed-entitlements report failed" >&2

# ============ Start ============
exec "$@"
```

- [ ] **Step 4: 镜像 build 验证 (可选,只跑 jq 已加 + skills 占位 copy)**

```bash
# 这步要求 docker 在跑;dev 环境也行
cd /Users/yanjiayi/workspace/laifu
docker build -t hermes-p1-check -f docker/hermes/Dockerfile docker/hermes/ 2>&1 | tail -20
docker run --rm hermes-p1-check which jq && echo "jq OK"
docker run --rm hermes-p1-check ls /opt/hermes-skills/cloud_publish/ && echo "skill placeholder OK"
docker rmi hermes-p1-check
```
Expected: jq 找到了；占位目录里有 SKILL.md。

可以省 docker build 步骤，留给 user 第一次跑容器时验证。

- [ ] **Step 5: Commit**

```bash
git add docker/hermes/Dockerfile docker/hermes/entrypoint.sh docker/hermes/skills/cloud_publish/SKILL.md
git commit -m "feat(hermes): entrypoint pulls entitlements + symlinks skills + reports observed"
```

---

## Task 13: 收尾 — 全量测试 + 集成验证 + 推 PR

**Files:** 无新增

- [ ] **Step 1: 全量测试**

```bash
pnpm test 2>&1 | tail -30
```
Expected: gateway + shared 全绿；web 仍 fail 3 个 EventSource（P0 期间确认的预存在问题，跟 P1 无关）。

- [ ] **Step 2: 全量 lint**

```bash
pnpm lint
```
Expected: 无错。

- [ ] **Step 3: 手动 e2e 验证（需要 supabase 本地 + gateway 在跑）**

```bash
# Supabase 已经在跑（验证）
supabase status --workdir /Users/yanjiayi/workspace/laifu/infra | head -5

# 启动 gateway
cd /Users/yanjiayi/workspace/laifu && pnpm dev:gateway &
sleep 5

# (准备一个测试用 user_id；如果没有现成 user 行,直接 psql insert)
TEST_USER_ID=$(PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -tA -c "
  INSERT INTO users (provider, external_id, email)
  VALUES ('test', 'p1-e2e-test', 'p1@test.local')
  ON CONFLICT (provider, external_id) DO UPDATE SET email=excluded.email
  RETURNING id;
")
echo "TEST_USER_ID=$TEST_USER_ID"

# 模拟 session cookie 不容易跨平台脚本化,这里只测无需 session 的端点:
# 1. me/entitlements 需要 JWT(应该 401 无 token):
curl -i http://localhost:9000/api/me/entitlements
# Expected: 401 missing or non-Bearer

# 2. status 端点需要 session cookie,前端登录后才能测;这里跳过

# 关 gateway
kill %1
```

- [ ] **Step 4: Commit log review**

```bash
git log --oneline main..HEAD | head -30
```
Expected: 17 P0 commits + ~12 P1 commits = 约 30 个总 commits。

- [ ] **Step 5: 推到远端**

```bash
git push -u origin feat/cloud-drive
```

- [ ] **Step 6: 选择是否开 PR**

P1 完成后通常仍不开 PR,因为 P2-P7 还会往同一分支累加。如果想分多个 PR：

```bash
gh pr create --base main --title "feat(cloud-drive): P0+P1 — SAS infra + entitlement closed-loop" --body "$(cat <<'EOF'
## Summary
- P0: Azure HNS storage / directory SAS hand-signing / UDK cache / virtual-path
- P1: entitlement + token + observed-state closed loop
  - DB: user_entitlements + container_observed_state + users.token_version
  - gateway: /api/entitlements/cloud/{enable,disable}, /api/me/{entitlements,observed-entitlements}, /api/auth/refresh-token
  - provisioning: signTokenAndInject + restartContainerApp helpers
  - container: entrypoint pulls entitlements, symlinks skills, reports observed

## Test plan
- [ ] All unit tests pass (gateway + shared)
- [ ] Manual: enable→disable→enable cycle restores active state
- [ ] Manual: refresh-token works within grace, rejects beyond
- [ ] Manual: ACA container restart triggers correctly

🤖 Generated with Claude Code
EOF
)"
```

或者不开 PR，留分支继续 P2+。

---

## 验收清单 (P1 整体)

- [ ] migration 0006 应用到本地，三个 schema 改动都到位
- [ ] `gateway-token` 9 个测试全绿
- [ ] `container-token` middleware 6 个测试全绿
- [ ] `entitlements-dao` + `observed-state-dao` 共 7 个测试全绿
- [ ] `/api/me/entitlements` + `/api/me/observed-entitlements` 共 5 个测试全绿
- [ ] `/api/auth/refresh-token` 5 个测试全绿（含 grace 期）
- [ ] `/api/entitlements/cloud/enable\|disable` 3 个测试全绿
- [ ] `/api/status` 3 个测试全绿
- [ ] provisioning helpers 加好（azure 真实 / local mock）
- [ ] index.ts 路由都装上，启动不报错
- [ ] Dockerfile + entrypoint.sh 改动应用，jq 装上，占位 skill 文件就位
- [ ] 全量 `pnpm test` 绿色（除 web 的 EventSource 预存在问题）
- [ ] 12 个新 commit 干净，对应 12 个 task

---

## 风险与未决项

| 项 | 风险 | 缓解 |
|---|---|---|
| `bumpTokenVersion` 用 read-then-write 不原子 | 并发 enable + disable 时 token_version 可能丢一次 +1 | P1 单用户单 session 几乎不并发；上线发生再换 RPC 函数 |
| ACA `restartRevision` 行为差异 | 不同 SKU / region 的 ACA restart 语义可能不同 | Task 10 实施时实测一次；必要时换成 `deleteRevision` + 等 auto-redeploy |
| entrypoint 的 base64url JWT 解码很脆 | bash 字符串处理可能在 padding 边界出错 | 加单独的 docker build 测试验证；shell 脚本容错性靠 P1 上线时跑通真实 token |
| local provisioner 不真注入 token | dev 流程无法验证 entitlement enable → 容器重启 → skill 上报 | 接受这点；e2e 走 staging Azure |
| `apps/web` 的 EventSource 测试失败 | P0 期间确认预存在，与 P1 无关 | 单独 ticket，本 plan 不修 |

### Open Questions (实施时决定)

- bumpTokenVersion 是否要立刻替换成 RPC 函数？（看 Supabase RPC 定义经验如何）
- `GATEWAY_BASE_URL` 在 ACA 里怎么传？（内部域名 / Private Endpoint / public DNS）—— provisioning 加 env 时决定
- entrypoint refresh-token 失败时是否应 fail-fast？现在是 warn 继续 —— 接受这个选择，让容器仍能启动跑非 cloud 流程

---

## 相关文档

- 设计 spec：`docs/superpowers/specs/2026-06-01-cloud-drive-design.md`
- P0 plan：`docs/superpowers/plans/2026-06-01-cloud-drive-p0.md`
- 平台架构：`docs/superpowers/specs/architecture-overview.md`
