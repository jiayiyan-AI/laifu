# 修改密码 + 找回密码 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 邮箱密码账号能在网页上自助修改密码、通过邮件链接找回密码；改 / 重置后其他会话失效。

**Architecture:**
- `users` 加 `session_version`，session JWT 带 `sv`。`requireSession` 比对 `sv`（30s 进程内缓存，DB 故障时放行）。
- 新表 `password_reset_tokens` 只存 sha256，原子 UPDATE 消费。
- 系统邮件复用现有的 Resend `EmailProvider`。
- 进程内固定窗口限流。
- 前端新增修改密码弹窗和两个公开页面。

**Tech Stack:** Express 4 + TypeScript、Drizzle ORM (PG)、bcryptjs、jsonwebtoken、vitest + supertest；React 18 + react-router v6 + @testing-library/react。

**Spec:** `docs/superpowers/specs/2026-10-08-password-change-reset-design.md`（执行前必读）

## Global Constraints

- **禁止任何 git 操作**（add / commit / branch 等）。用户自己管 git，每个 Task 结尾的"检查点"只跑测试，不提交。
- 不写 `NODE_ENV === 'production'` 分支；**不新增 env**。
- 代码注释、日志文案、用户可见文案一律中文（日志事件名用英文点分，如 `auth.password.forgot`）。
- Express async handler 必须包 try/catch（Express 4 不捕获 reject，会拖垮进程）。
- bcrypt cost = 10（沿用 `BCRYPT_ROUNDS`）；密码 ≥ 8 字符（`MIN_PASSWORD_LENGTH`）且 UTF-8 ≤ 72 字节。
- 重置 token：`randomBytes(32).toString('base64url')`，库里存 `sha256 hex`，有效期 **30 分钟**，一次性。过期判断一律用 DB 的 `now()`，不用应用侧时间。
- 发件人：`noreply@${config.email.domain}`，显示名 `灵犀`；链接前缀为 `config.auth.frontendBaseUrl || config.auth.publicBaseUrl`。
- `users.token_version` **不能动**（它管容器 token，动了会让用户的 hermes 容器鉴权失效）。
- 不碰任何云上资源。prod 迁移和部署由用户另行批准。
- gateway 测试：`pnpm --filter @lingxi/gateway test`（也可以 `-- <file>` 只跑单个文件）。web 测试：`pnpm --filter web test`。shared 测试：`pnpm --filter @lingxi/shared test`。执行前先 `cat apps/*/package.json packages/*/package.json | grep '"name"'` 确认包名，如果包名不同，按实际包名替换。
- web 的 `pnpm lint` 在基线上就是红的，**不作为通过门**；web 的通过门是 test + build。

## Review Focus

1. **邮箱大小写 / 空格**：用户注册时填的是 `Jiaqian@Pawsiv.cn`，忘记密码时填 ` jiaqian@pawsiv.cn `，应该能收到信。→ Task 6 测试 `forgot: 邮箱前后空格+大写也命中`。
2. **改过密码的用户拿着老 JWT（没有 sv）**：DB 里 sv=1，老 cookie 必须被拒，不能当 0 放过。→ Task 3 测试 `无 sv 的老 JWT 在 session_version=1 时被拒`。
3. **Google 账号用同一个邮箱申请找回**：不能发信，也不能把 Google 账号变成密码账号。→ Task 6 测试 `forgot: OAuth 用户邮箱不发信`（依赖 `getPasswordUserByEmail` 只查 provider='password'）。
4. **邮件客户端给链接 token 带上首尾空白或换行**：应该 trim 后正常使用。→ Task 6 测试 `reset: token 首尾空白被 trim`。
5. **桌面端 home 窗口在别处改密码后变成 401**：不能白屏，应该跳到登录页。现有 `ProtectedRoute` 在 unauthenticated 时会 `<Navigate to="/login">`。→ Task 8 冒烟时手工验证：A 浏览器改密码，B 浏览器刷新后跳到 /login。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `packages/shared/src/password.ts` | 新建 | `validateNewPassword`、`MAX_PASSWORD_BYTES` |
| `packages/shared/src/password.test.ts` | 新建 | 规则边界测试 |
| `packages/shared/src/contracts.ts` | 改 | `AuthErrorCode` 扩充，新增请求类型 |
| `packages/shared/src/assistant.ts` (+test) | 改 | 保留 localpart |
| `packages/shared/src/index.ts` | 改 | 导出 password.ts |
| `packages/db/src/schema.ts` | 改 | `session_version` 列、`passwordResetTokens` 表 |
| `packages/db/drizzle/0007_*.sql` | 生成 | 迁移 |
| `apps/gateway/src/db/users-dao.ts` | 改 | `getSessionVersion` / `getPasswordAuthById` / `updatePasswordAndBumpSession`；`getPasswordUserByEmail` 增加返回 `session_version` |
| `apps/gateway/src/db/password-reset-dao.ts` | 新建 | `create` / `consume` |
| `apps/gateway/src/db/index.ts` | 改 | 注册 `passwordResets` |
| `apps/gateway/test/helpers/mock-dao.ts` | 改 | mock 新方法 |
| `apps/gateway/src/auth/session.ts` | 改 | payload 加 `sv` |
| `apps/gateway/src/auth/session-version.ts` | 新建 | 带 TTL 缓存的 version store，以及 `issueSessionCookie` |
| `apps/gateway/src/auth/middleware.ts` | 改 | 异步比对 sv |
| `apps/gateway/src/auth/oauth-router.ts`、`src/api/session-handoff.ts`、`src/auth/session-routes.ts`、`src/index.ts` | 改 | 签发时带 sv、中间件传 store、trust proxy、共享 emailProvider |
| `apps/gateway/src/lib/rate-limit.ts` (+test) | 新建 | 固定窗口限流 |
| `apps/gateway/src/lib/email/system-mailer.ts` (+test) | 新建 | 重置邮件 |
| `apps/gateway/src/auth/password-routes.ts` (+test) | 改 | change / forgot / reset |
| `apps/web/src/lib/api.ts` | 改 | 3 个 API |
| `apps/web/src/auth/passwordErrors.ts` | 新建 | 错误码 → 中文（LoginPage 和新页面共用） |
| `apps/web/src/auth/ForgotPasswordPage.tsx`、`ResetPasswordPage.tsx` (+tests) | 新建 | 公开页面 |
| `apps/web/src/desktop/ChangePasswordDialog.tsx` (+test) | 新建 | 修改密码弹窗 |
| `apps/web/src/desktop/Menubar.tsx`、`src/auth/LoginPage.tsx`、`src/App.tsx` | 改 | 入口和路由 |

---

### Task 1: shared — 密码规则、错误码、保留邮箱前缀

**Files:**
- Create: `packages/shared/src/password.ts`, `packages/shared/src/password.test.ts`
- Modify: `packages/shared/src/contracts.ts:113-129`, `packages/shared/src/assistant.ts:20-24`, `packages/shared/src/assistant.test.ts`, `packages/shared/src/index.ts`

**Interfaces:**
- Produces:
  - `validateNewPassword(pw: string): 'password_too_short' | 'password_too_long' | null`
  - `MAX_PASSWORD_BYTES = 72`
  - `AuthErrorCode` 新增 `'password_too_long' | 'not_password_account' | 'wrong_password' | 'invalid_or_expired_token' | 'rate_limited'`
  - `PasswordChangeRequest { current_password: string; new_password: string }`
  - `PasswordForgotRequest { email: string }`
  - `PasswordResetRequest { token: string; new_password: string }`
  - `RESERVED_EMAIL_LOCALPARTS: readonly string[]`

> 注：spec 里写的 `weak_password`，这里按长度细分为现有的 `password_too_short` 和新增的 `password_too_long`，与现有注册错误码保持一致，前端文案更准确。

- [ ] **Step 1: 写失败测试** `packages/shared/src/password.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { validateNewPassword, MAX_PASSWORD_BYTES } from './password.js';

describe('validateNewPassword', () => {
  it('7 字符 → password_too_short', () => {
    expect(validateNewPassword('a'.repeat(7))).toBe('password_too_short');
  });
  it('8 字符 → 合法', () => {
    expect(validateNewPassword('a'.repeat(8))).toBeNull();
  });
  it('72 字节 → 合法, 73 字节 → password_too_long', () => {
    expect(validateNewPassword('a'.repeat(MAX_PASSWORD_BYTES))).toBeNull();
    expect(validateNewPassword('a'.repeat(MAX_PASSWORD_BYTES + 1))).toBe('password_too_long');
  });
  it('多字节按 UTF-8 字节算: 24 个汉字=72 字节合法, 25 个=75 字节超长', () => {
    expect(validateNewPassword('密'.repeat(24))).toBeNull();
    expect(validateNewPassword('密'.repeat(25))).toBe('password_too_long');
  });
  it('8 个汉字字符数够 8 → 合法(长度下限按字符数, 与现有注册一致)', () => {
    expect(validateNewPassword('密'.repeat(8))).toBeNull();
  });
});
```

在 `assistant.test.ts` 的 `describe('isValidEmailLocalpart'` 块里追加：

```ts
  it('拒绝系统保留前缀', () => {
    for (const s of ['noreply', 'no-reply', 'postmaster', 'admin', 'support', 'security', 'abuse']) {
      expect(isValidEmailLocalpart(s)).toBe(false);
    }
  });
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm --filter @lingxi/shared test`
Expected: FAIL（`./password.js` 不存在；保留字用例断言失败）

- [ ] **Step 3: 实现**

`packages/shared/src/password.ts`：

```ts
import { MIN_PASSWORD_LENGTH } from './contracts.js';

/** bcrypt 只取前 72 字节, 超出部分被静默忽略 → 直接拒绝, 避免"改了后半截密码仍能登录"。 */
export const MAX_PASSWORD_BYTES = 72;

/**
 * 新密码规则(注册 / 修改 / 重置共用, 前端即时校验也用它)。
 * 合法返回 null, 否则返回对应 AuthErrorCode。
 */
export const validateNewPassword = (pw: string): 'password_too_short' | 'password_too_long' | null => {
  if (pw.length < MIN_PASSWORD_LENGTH) return 'password_too_short';
  if (new TextEncoder().encode(pw).length > MAX_PASSWORD_BYTES) return 'password_too_long';
  return null;
};
```

`contracts.ts`：把 `AuthErrorCode` 改成下面这样，并在 `PasswordRegisterRequest` 后面加三个请求类型：

```ts
/** 认证类接口的稳定错误码。前端据此给精确提示，不靠英文文案字符串匹配。 */
export type AuthErrorCode =
  | 'invalid_email'
  | 'password_too_short'
  | 'password_too_long'
  | 'email_taken'
  | 'invalid_credentials'
  | 'not_password_account'
  | 'wrong_password'
  | 'invalid_or_expired_token'
  | 'rate_limited';

/** 已登录修改密码 */
export interface PasswordChangeRequest {
  current_password: string;
  new_password: string;
}

/** 申请找回密码邮件 */
export interface PasswordForgotRequest {
  email: string;
}

/** 凭邮件链接 token 重置密码 */
export interface PasswordResetRequest {
  token: string;
  new_password: string;
}
```

`assistant.ts`：在 `isValidEmailLocalpart` 前面加常量，并在函数末尾检查保留字：

```ts
/** 系统发件 / 运维用前缀, 不许用户占用(否则会收到系统邮件的退信与回复)。 */
export const RESERVED_EMAIL_LOCALPARTS: readonly string[] = [
  'noreply', 'no-reply', 'postmaster', 'admin', 'support', 'security', 'abuse',
];
```

函数体最后一行改成：

```ts
  if (!/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(s)) return false;
  return !RESERVED_EMAIL_LOCALPARTS.includes(s);
```

`index.ts` 追加：`export * from './password.js';`

- [ ] **Step 4: 跑测试，确认通过**

Run: `pnpm --filter @lingxi/shared test && pnpm --filter @lingxi/shared build`
Expected: PASS；build 成功（gateway / web 依赖 shared 的 dist）

- [ ] **Step 5: 检查点**（不提交）：`pnpm --filter @lingxi/gateway test` 全绿。注册路由还没改，现有测试不受影响。

---

### Task 2: DB — schema、迁移、DAO

**Files:**
- Modify: `packages/db/src/schema.ts:18-33`（users 表），在文件末尾或 users 表之后加新表
- Generate: `packages/db/drizzle/0007_password_reset.sql`（文件名由 drizzle-kit 生成）
- Modify: `apps/gateway/src/db/users-dao.ts`、`apps/gateway/src/db/index.ts`、`apps/gateway/test/helpers/mock-dao.ts`
- Create: `apps/gateway/src/db/password-reset-dao.ts`、`apps/gateway/test/db/password-reset-dao.test.ts`

**Interfaces:**
- Produces（`dao.users`）：
  - `getSessionVersion(userId: string): Promise<number | null>`
  - `getPasswordAuthById(userId: string): Promise<{ provider: string; password_hash: string | null } | null>`
  - `updatePasswordAndBumpSession(userId: string, hash: string): Promise<number | null>`：返回新的 session_version，用户不存在时返回 null
  - `getPasswordUserByEmail` 的返回行新增 `session_version: number`
- Produces（`dao.passwordResets`）：
  - `create(input: { userId: string; tokenHash: string; ttlMinutes: number }): Promise<void>`：同时作废该用户所有未用 token
  - `consume(tokenHash: string): Promise<string | null>`：成功返回 user_id

- [ ] **Step 1: 改 schema**

`users` 表里，在 `password_hash` 下面加一行：

```ts
  // 网页 session 吊销版本号。改密码 / 重置密码时 +1, session JWT 里的 sv 不等即失效。
  // 与 token_version(容器 / 设备 token)刻意分开: 改密码不能让用户的 hermes 容器掉线。
  session_version: integer('session_version').notNull().default(0),
```

users 表定义之后加：

```ts
// ── password_reset_tokens (0007) ────────────────────────────────────────
// 找回密码一次性 token。只存 sha256(token), 原文只出现在邮件里。
export const passwordResetTokens = pgTable('password_reset_tokens', {
  token_hash: text('token_hash').primaryKey(),
  user_id: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  used_at: timestamp('used_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('password_reset_tokens_user_id_idx').on(t.user_id),
]);
```

- [ ] **Step 2: 生成迁移，并在本地库验证**

```bash
cd /Users/yanjiayi/workspace/laifu
grep DATABASE_URL apps/gateway/.env.local   # 拿本地库 URL (由 ./scripts/dev-db.sh 起的那个)
cd packages/db
DATABASE_URL=<本地URL> pnpm db:generate --name password_reset
cat drizzle/0007_password_reset.sql
```

Expected：SQL **只有** `ALTER TABLE "users" ADD COLUMN "session_version" integer DEFAULT 0 NOT NULL`、`CREATE TABLE "password_reset_tokens" ...`、外键和索引。如果 drizzle 顺带生成了 `users_email_unique` 等无关 DDL（它不认识这个表达式索引），**手工从 SQL 里删掉这些无关语句**，然后跟用户说明。

```bash
DATABASE_URL=<本地URL> pnpm db:migrate
psql <本地URL> -c '\d password_reset_tokens' -c '\d users' | grep -E 'session_version|token_hash|expires_at'
pnpm build
```

Expected：迁移成功，能看到新列和新表；`@lingxi/db` build 通过。

- [ ] **Step 3: 写 DAO 失败测试** `apps/gateway/test/db/password-reset-dao.test.ts`

单测只验证调用形状：先作废旧 token 再插入，consume 带 returning。真正的原子性靠 SQL 保证，在 Task 8 冒烟时对本地 PG 验证。

```ts
import { describe, it, expect, vi } from 'vitest';
import { makePasswordResetDao } from '../../src/db/password-reset-dao.js';

const mockDb = (returningRows: any[] = []) => {
  const calls: string[] = [];
  const updateChain: any = {
    set: vi.fn(() => updateChain),
    where: vi.fn(() => updateChain),
    returning: vi.fn(async () => returningRows),
    then: (resolve: any) => resolve(undefined),
  };
  const insertChain: any = {
    values: vi.fn(async () => undefined),
  };
  const tx = {
    update: vi.fn(() => { calls.push('update'); return updateChain; }),
    insert: vi.fn(() => { calls.push('insert'); return insertChain; }),
  };
  const db: any = {
    ...tx,
    transaction: vi.fn(async (fn: any) => fn(tx)),
  };
  return { db, calls, insertChain, updateChain };
};

describe('passwordResetDao', () => {
  it('create: 事务内先作废旧 token 再插入新 token', async () => {
    const { db, calls, insertChain } = mockDb();
    await makePasswordResetDao(db).create({ userId: 'u1', tokenHash: 'h1', ttlMinutes: 30 });
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(calls).toEqual(['update', 'insert']);
    expect(insertChain.values.mock.calls[0][0]).toMatchObject({ token_hash: 'h1', user_id: 'u1' });
  });

  it('consume: 命中返回 user_id', async () => {
    const { db } = mockDb([{ user_id: 'u1' }]);
    expect(await makePasswordResetDao(db).consume('h1')).toBe('u1');
  });

  it('consume: 未命中(过期/已用/不存在)返回 null', async () => {
    const { db } = mockDb([]);
    expect(await makePasswordResetDao(db).consume('h1')).toBeNull();
  });
});
```

Run: `pnpm --filter @lingxi/gateway test -- test/db/password-reset-dao.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现 DAO**

`apps/gateway/src/db/password-reset-dao.ts`：

```ts
/**
 * password_reset_tokens DAO — 找回密码一次性 token。
 * 过期判断一律用 DB now(), 不信应用侧时钟。
 * 消费方: auth/password-routes.ts
 */
import type { Db } from '@lingxi/db';
import { schema } from '@lingxi/db';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';

export interface PasswordResetDao {
  /** 作废该用户所有未用 token, 再插入新 token(同一事务)。 */
  create(input: { userId: string; tokenHash: string; ttlMinutes: number }): Promise<void>;
  /** 原子消费: 未用且未过期才命中, 返回 user_id; 否则 null。并发下只有一个调用能拿到。 */
  consume(tokenHash: string): Promise<string | null>;
}

export const makePasswordResetDao = (db: Db): PasswordResetDao => {
  const t = schema.passwordResetTokens;
  return {
    async create({ userId, tokenHash, ttlMinutes }) {
      await db.transaction(async (tx) => {
        await tx.update(t).set({ used_at: sql`now()` })
          .where(and(eq(t.user_id, userId), isNull(t.used_at)));
        await tx.insert(t).values({
          token_hash: tokenHash,
          user_id: userId,
          expires_at: sql`now() + make_interval(mins => ${ttlMinutes})`,
        });
      });
    },

    async consume(tokenHash) {
      const rows = await db.update(t).set({ used_at: sql`now()` })
        .where(and(eq(t.token_hash, tokenHash), isNull(t.used_at), gt(t.expires_at, sql`now()`)))
        .returning({ user_id: t.user_id });
      return rows[0]?.user_id ?? null;
    },
  };
};
```

`users-dao.ts`：
- `UsersDao` 接口加三个方法。
- `getPasswordUserByEmail` 的返回类型改成 `(UserRow & { password_hash: string | null; session_version: number }) | null`，select 里加 `session_version: u.session_version,`。
- import 里加 `sql`：`import { eq, and, sql } from 'drizzle-orm';`
- 实现：

```ts
    async getSessionVersion(userId) {
      const rows = await db.select({ sv: u.session_version })
        .from(u).where(eq(u.id, userId)).limit(1);
      return rows[0]?.sv ?? null;
    },

    async getPasswordAuthById(userId) {
      const rows = await db.select({ provider: u.provider, password_hash: u.password_hash })
        .from(u).where(eq(u.id, userId)).limit(1);
      return rows[0] ?? null;
    },

    async updatePasswordAndBumpSession(userId, hash) {
      // 单条 UPDATE: 写 hash 与 sv+1 原子完成, 返回新 sv 供当前设备换发 cookie。
      const rows = await db.update(u)
        .set({ password_hash: hash, session_version: sql`${u.session_version} + 1` })
        .where(eq(u.id, userId))
        .returning({ sv: u.session_version });
      return rows[0]?.sv ?? null;
    },
```

`db/index.ts`：
- import `makePasswordResetDao, type PasswordResetDao`
- `Dao` 接口加 `passwordResets: PasswordResetDao;`
- `factories` 加 `passwordResets: () => makePasswordResetDao(getDb()),`

`test/helpers/mock-dao.ts`：
- `users` 块追加：

```ts
    getSessionVersion: vi.fn(async () => 0),
    getPasswordAuthById: vi.fn(async () => null),
    updatePasswordAndBumpSession: vi.fn(async () => 1),
```

- 在顶层追加：

```ts
  passwordResets: {
    create: vi.fn(async () => {}),
    consume: vi.fn(async () => null),
  },
```

- [ ] **Step 5: 跑测试 + 类型检查**

Run: `pnpm --filter @lingxi/gateway test && pnpm --filter @lingxi/gateway exec tsc --noEmit`
Expected: 全部 PASS，无类型错误

- [ ] **Step 6: 检查点**（不提交）

---

### Task 3: 会话吊销（session_version）

**Files:**
- Modify: `apps/gateway/src/auth/session.ts`、`apps/gateway/src/auth/middleware.ts`、`apps/gateway/src/auth/session-routes.ts:19`、`apps/gateway/src/auth/oauth-router.ts:162-163`、`apps/gateway/src/api/session-handoff.ts:98-99`、`apps/gateway/src/index.ts:78-81`
- Create: `apps/gateway/src/auth/session-version.ts`、`apps/gateway/test/auth/session-version.test.ts`
- Test: `apps/gateway/test/auth/middleware.test.ts`、`apps/gateway/test/auth/session.test.ts`

**Interfaces:**
- Consumes: `dao.users.getSessionVersion`（Task 2）
- Produces:
  - `SessionPayload { user_id: string; sv?: number }`
  - `interface SessionVersionStore { get(userId: string): Promise<number | null>; invalidate(userId: string): void }`
  - `makeSessionVersionStore(fetch: (uid: string) => Promise<number | null>, opts?: { ttlMs?: number; now?: () => number }): SessionVersionStore`
  - `sessionVersions: SessionVersionStore`（进程单例，fetch 走 `dao.users.getSessionVersion`）
  - `issueSessionCookie(res: Response, userId: string, opts: { sessionSecret: string; cookieName: string; ttlHours: number }, sv?: number): Promise<void>`：不传 sv 时从 `sessionVersions.get` 取，用户不存在时抛错
  - `RequireSessionOpts` 增加可选 `versions?: SessionVersionStore`。不传就不做版本检查（保持现有大量路由测试不用改）；**生产装配（index.ts、session-routes.ts、password-routes.ts）必须传**。

- [ ] **Step 1: 写失败测试**

`test/auth/session.test.ts` 追加：

```ts
  it('sv 透传: 签入 sv=3 → verify 得到 sv=3; 不签 sv → verify 得到 undefined', () => {
    const a = verifySession(signSession({ user_id: 'u1', sv: 3 }, SECRET, 1), SECRET);
    expect(a).toEqual({ user_id: 'u1', sv: 3 });
    const b = verifySession(signSession({ user_id: 'u1' }, SECRET, 1), SECRET);
    expect(b).toEqual({ user_id: 'u1' });
  });
```

（如果该文件里的密钥常量名不叫 `SECRET`，按文件里实际的名字替换。）

新建 `test/auth/session-version.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { makeSessionVersionStore } from '../../src/auth/session-version.js';

describe('makeSessionVersionStore', () => {
  it('TTL 内命中缓存, 不重复查库', async () => {
    const fetch = vi.fn(async () => 2);
    let t = 0;
    const s = makeSessionVersionStore(fetch, { ttlMs: 30_000, now: () => t });
    expect(await s.get('u1')).toBe(2);
    t = 29_999;
    expect(await s.get('u1')).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('TTL 过后重新查库', async () => {
    const fetch = vi.fn(async () => 2);
    let t = 0;
    const s = makeSessionVersionStore(fetch, { ttlMs: 30_000, now: () => t });
    await s.get('u1');
    t = 30_001;
    await s.get('u1');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('invalidate 后立即重新查库', async () => {
    const fetch = vi.fn(async () => 2);
    const s = makeSessionVersionStore(fetch, { ttlMs: 30_000, now: () => 0 });
    await s.get('u1');
    s.invalidate('u1');
    await s.get('u1');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('用户不存在(null)不缓存', async () => {
    const fetch = vi.fn(async () => null);
    const s = makeSessionVersionStore(fetch, { ttlMs: 30_000, now: () => 0 });
    expect(await s.get('u1')).toBeNull();
    await s.get('u1');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
```

`test/auth/middleware.test.ts`：把 `makeApp` 改成可以传 store，并追加用例：

```ts
import { makeSessionVersionStore } from '../../src/auth/session-version.js';

const makeApp = (versions?: ReturnType<typeof makeSessionVersionStore>) => {
  const app = express();
  app.use(cookieParser());
  app.get('/protected', requireSession({ secret: SECRET, cookieName: COOKIE_NAME, versions }), (req, res) => {
    const user = (req as any).session;
    res.json({ user_id: user.user_id });
  });
  return app;
};

describe('requireSession + session_version', () => {
  const storeOf = (v: number | null | Error) =>
    makeSessionVersionStore(async () => { if (v instanceof Error) throw v; return v; });

  it('无 sv 的老 JWT 在 session_version=0 时通过(上线不踢人)', async () => {
    const token = signSession({ user_id: 'u1' }, SECRET, 24);
    const res = await request(makeApp(storeOf(0))).get('/protected').set('Cookie', `${COOKIE_NAME}=${token}`);
    expect(res.status).toBe(200);
  });

  it('无 sv 的老 JWT 在 session_version=1 时被拒', async () => {
    const token = signSession({ user_id: 'u1' }, SECRET, 24);
    const res = await request(makeApp(storeOf(1))).get('/protected').set('Cookie', `${COOKIE_NAME}=${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('session revoked');
  });

  it('sv 一致通过, 不一致 401', async () => {
    const ok = signSession({ user_id: 'u1', sv: 2 }, SECRET, 24);
    const bad = signSession({ user_id: 'u1', sv: 1 }, SECRET, 24);
    expect((await request(makeApp(storeOf(2))).get('/protected').set('Cookie', `${COOKIE_NAME}=${ok}`)).status).toBe(200);
    expect((await request(makeApp(storeOf(2))).get('/protected').set('Cookie', `${COOKIE_NAME}=${bad}`)).status).toBe(401);
  });

  it('用户不存在 → 401', async () => {
    const token = signSession({ user_id: 'gone', sv: 0 }, SECRET, 24);
    const res = await request(makeApp(storeOf(null))).get('/protected').set('Cookie', `${COOKIE_NAME}=${token}`);
    expect(res.status).toBe(401);
  });

  it('查库抛错 → 放行(fail-open, 不因 DB 抖动全站 401)', async () => {
    const token = signSession({ user_id: 'u1', sv: 5 }, SECRET, 24);
    const res = await request(makeApp(storeOf(new Error('db down')))).get('/protected').set('Cookie', `${COOKIE_NAME}=${token}`);
    expect(res.status).toBe(200);
  });
});
```

Run: `pnpm --filter @lingxi/gateway test -- test/auth/`
Expected: FAIL（`session-version.js` 不存在；sv 没有透传）

- [ ] **Step 2: 实现 session.ts**

```ts
export interface SessionPayload {
  user_id: string;
  /** session_version 快照。缺省 = 0(本字段上线前签发的老 JWT)。 */
  sv?: number;
}
```

`verifySession` 的返回改成：

```ts
  const d = decoded as { user_id: string; sv?: unknown };
  return typeof d.sv === 'number' ? { user_id: d.user_id, sv: d.sv } : { user_id: d.user_id };
```

`signSession` 不用改（jwt.sign 会原样带上 sv）。

- [ ] **Step 3: 实现 session-version.ts**

```ts
/**
 * 网页 session 吊销: users.session_version 的带 TTL 进程内缓存 + 统一签发入口。
 * 单实例 B1 部署, 进程内缓存足够; 改密码路径主动 invalidate, 其他设备最多 ttl 内仍有效。
 */
import type { Response } from 'express';
import { signSession, sessionCookieOpts } from './session.js';
import { dao } from '../db/index.js';

export interface SessionVersionStore {
  get(userId: string): Promise<number | null>;
  invalidate(userId: string): void;
}

export const makeSessionVersionStore = (
  fetch: (userId: string) => Promise<number | null>,
  opts: { ttlMs?: number; now?: () => number } = {},
): SessionVersionStore => {
  const ttlMs = opts.ttlMs ?? 30_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { sv: number; at: number }>();
  return {
    async get(userId) {
      const hit = cache.get(userId);
      if (hit && now() - hit.at < ttlMs) return hit.sv;
      const sv = await fetch(userId);
      if (sv === null) { cache.delete(userId); return null; }
      cache.set(userId, { sv, at: now() });
      return sv;
    },
    invalidate(userId) {
      cache.delete(userId);
    },
  };
};

export const sessionVersions: SessionVersionStore =
  makeSessionVersionStore((uid) => dao.users.getSessionVersion(uid));

export interface IssueSessionOpts {
  sessionSecret: string;
  cookieName: string;
  ttlHours: number;
}

/** 所有签发网页 session cookie 的地方都走这里, 保证 JWT 带上当前 sv。 */
export const issueSessionCookie = async (
  res: Response, userId: string, opts: IssueSessionOpts, sv?: number,
): Promise<void> => {
  const v = sv ?? await sessionVersions.get(userId);
  if (v === null) throw new Error(`issueSessionCookie: user not found ${userId}`);
  const token = signSession({ user_id: userId, sv: v }, opts.sessionSecret, opts.ttlHours);
  res.cookie(opts.cookieName, token, sessionCookieOpts(opts.ttlHours));
};
```

- [ ] **Step 4: 实现 middleware.ts**

```ts
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { verifySession, type SessionPayload } from './session.js';
import type { SessionVersionStore } from './session-version.js';

export interface RequireSessionOpts {
  secret: string;
  cookieName: string;
  /** 传了就比对 users.session_version(改密码后旧会话失效)。生产装配必须传。 */
  versions?: SessionVersionStore;
}

// (declare global 块保持不变)

export const requireSession = (opts: RequireSessionOpts): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
    const token = cookies[opts.cookieName];
    if (!token) {
      res.status(401).json({ error: 'not authenticated' });
      return;
    }
    let payload: SessionPayload;
    try {
      payload = verifySession(token, opts.secret);
    } catch {
      res.status(401).json({ error: 'invalid session' });
      return;
    }
    if (opts.versions) {
      let current: number | null;
      try {
        current = await opts.versions.get(payload.user_id);
      } catch (err) {
        // fail-open: DB 抖动时不让全站 401; 代价是这一刻吊销不生效。
        console.error(`[requireSession] session_version 查询失败, 放行 user=${payload.user_id}:`, err);
        req.session = payload;
        next();
        return;
      }
      if (current === null) {
        res.status(401).json({ error: 'user not found' });
        return;
      }
      if ((payload.sv ?? 0) !== current) {
        console.warn(`[requireSession] auth.session.revoked user=${payload.user_id} sv=${payload.sv ?? 0} current=${current}`);
        res.status(401).json({ error: 'session revoked' });
        return;
      }
    }
    req.session = payload;
    next();
  };
};
```

- [ ] **Step 5: 生产装配和签发点**

- `index.ts:78`：`requireSession({ secret: ..., cookieName: ..., versions: sessionVersions })`，import `sessionVersions` from `./auth/session-version.js`。
- `session-routes.ts:19`：同样传 `versions: sessionVersions`。
- `oauth-router.ts:162-163`：替换成

  ```ts
  try {
    await issueSessionCookie(res, row.id, opts);
  } catch (e) {
    console.error(`[oauth-router] ${providerName} issue session failed:`, e);
    return res.status(500).json({ error: 'session issue failed' });
  }
  ```

  `opts` 已经有 `sessionSecret/cookieName/ttlHours`。删掉不再使用的 `signSession` / `sessionCookieOpts` import（第 76 行仍在用 `verifySession`，保留它）。
- `session-handoff.ts:91-101`：handler 改成 `async`，用 try/catch 包住：

  ```ts
  try {
    await issueSessionCookie(res, userId, { sessionSecret: deps.sessionSecret, cookieName: deps.cookieName, ttlHours: deps.ttlHours });
  } catch (e) {
    console.error('[session-handoff] issue session failed:', e);
    res.status(500).json({ error: 'internal' });
    return;
  }
  res.redirect(`${deps.frontendBaseUrl}/desktop`);
  ```

- Task 6 会把密码登录 / 注册也改成 `issueSessionCookie`，这里先不动 password-routes。

- [ ] **Step 6: 跑测试**

Run: `pnpm --filter @lingxi/gateway test && pnpm --filter @lingxi/gateway exec tsc --noEmit`
Expected: 全部 PASS。如果 `oauth-router.test.ts` / `session-handoff` 相关测试因为 sv 失败，确认 mock-dao 的 `getSessionVersion` 返回 0，并且测试断言的是 cookie 存在而不是精确的 JWT 内容。必要时按新行为改断言，不要改实现去迁就测试。

- [ ] **Step 7: 检查点**（不提交）

---

### Task 4: 限流 + trust proxy

**Files:**
- Create: `apps/gateway/src/lib/rate-limit.ts`、`apps/gateway/test/lib/rate-limit.test.ts`
- Modify: `apps/gateway/src/index.ts:65`（`express()` 之后）

**Interfaces:**
- Produces:
  - `makeRateLimiter(opts?: { now?: () => number }): RateLimiter`
  - `interface RateLimiter { hit(key: string, limit: number, windowMs: number): boolean; reset(): void }`：`hit` 返回 true 表示放行（并计数），false 表示超限（不计数）
  - `authRateLimiter: RateLimiter`（进程单例）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { makeRateLimiter } from '../../src/lib/rate-limit.js';

describe('makeRateLimiter', () => {
  it('窗口内超过 limit 拒绝, 窗口过后恢复', () => {
    let t = 0;
    const rl = makeRateLimiter({ now: () => t });
    expect(rl.hit('k', 2, 1000)).toBe(true);
    expect(rl.hit('k', 2, 1000)).toBe(true);
    expect(rl.hit('k', 2, 1000)).toBe(false);
    t = 1000;
    expect(rl.hit('k', 2, 1000)).toBe(true);
  });

  it('不同 key 互不影响', () => {
    const rl = makeRateLimiter({ now: () => 0 });
    expect(rl.hit('a', 1, 1000)).toBe(true);
    expect(rl.hit('b', 1, 1000)).toBe(true);
    expect(rl.hit('a', 1, 1000)).toBe(false);
  });

  it('同一 key 可叠加不同窗口(用 key 后缀区分)', () => {
    let t = 0;
    const rl = makeRateLimiter({ now: () => t });
    // 60s 1 次 + 1h 5 次
    const allow = () => rl.hit('e:1m', 1, 60_000) && rl.hit('e:1h', 5, 3_600_000);
    expect(allow()).toBe(true);
    expect(allow()).toBe(false);
    for (let i = 1; i < 5; i++) { t = i * 61_000; expect(allow()).toBe(true); }
    t = 5 * 61_000;
    expect(allow()).toBe(false); // 1h 内第 6 次
  });
});
```

Run: `pnpm --filter @lingxi/gateway test -- test/lib/rate-limit.test.ts` → Expected: FAIL

> 注意第三个用例的 `&&` 短路：1m 窗口拒绝时不会去计 1h 的数。这是预期行为，被拒的请求不消耗小时额度。

- [ ] **Step 2: 实现**

```ts
/**
 * 进程内固定窗口限流。单实例 B1 部署够用, 不引 Redis; 多实例时需换共享存储。
 * hit() 放行才计数, 被拒不计数。
 */
export interface RateLimiter {
  hit(key: string, limit: number, windowMs: number): boolean;
  reset(): void;
}

export const makeRateLimiter = (opts: { now?: () => number } = {}): RateLimiter => {
  const now = opts.now ?? Date.now;
  const buckets = new Map<string, { count: number; resetAt: number }>();
  let lastSweep = now();
  const sweep = (t: number) => {
    if (t - lastSweep < 60_000) return;
    lastSweep = t;
    for (const [k, b] of buckets) if (b.resetAt <= t) buckets.delete(k);
  };
  return {
    hit(key, limit, windowMs) {
      const t = now();
      sweep(t);
      const b = buckets.get(key);
      if (!b || b.resetAt <= t) {
        buckets.set(key, { count: 1, resetAt: t + windowMs });
        return true;
      }
      if (b.count >= limit) return false;
      b.count += 1;
      return true;
    },
    reset() {
      buckets.clear();
    },
  };
};

/** 认证类接口(找回 / 重置 / 修改密码)共用的限流器。 */
export const authRateLimiter: RateLimiter = makeRateLimiter();
```

- [ ] **Step 3: trust proxy**

`index.ts` 里 `const app = express();` 的下一行加：

```ts
  // App Service 前有一层 ARR 反代: 信任一跳 X-Forwarded-For, 让 req.ip 是真实客户端 IP(限流用)。
  app.set('trust proxy', 1);
```

确认没有其他代码依赖 `req.ip` / `req.protocol` / `req.secure`：

Run: `grep -rnE "req\.(ip|ips|protocol|secure|hostname)\b" apps/gateway/src`
Expected：没有输出。如果有输出，逐个评估，并在报告里写明。

- [ ] **Step 4: 测试**

Run: `pnpm --filter @lingxi/gateway test`
Expected: PASS

- [ ] **Step 5: 检查点**（不提交）

---

### Task 5: 系统邮件（重置邮件）

**Files:**
- Create: `apps/gateway/src/lib/email/system-mailer.ts`、`apps/gateway/test/lib/email/system-mailer.test.ts`
- Modify: `apps/gateway/src/index.ts:198-228`（共享 emailProvider 实例）

**Interfaces:**
- Consumes: `EmailProvider`（`lib/email/provider.ts`）
- Produces:
  - `makeSystemMailer(deps: { provider: EmailProvider; domain: string; linkBase: string; logLinks: boolean }): SystemMailer`
  - `interface SystemMailer { sendPasswordReset(to: string, token: string): Promise<void> }`
  - `resetLinkBase(cfg: { frontendBaseUrl: string; publicBaseUrl: string }): string`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi } from 'vitest';
import { makeSystemMailer, resetLinkBase } from '../../../src/lib/email/system-mailer.js';

const fakeProvider = () => ({
  parseInbound: vi.fn(),
  send: vi.fn(async () => ({ message_id: '<x@d>' })),
});

describe('system-mailer', () => {
  it('sendPasswordReset: noreply 发件, 正文含链接与 30 分钟提示', async () => {
    const provider = fakeProvider();
    const m = makeSystemMailer({ provider, domain: 'mail.example.org', linkBase: 'https://app.example.org', logLinks: false });
    await m.sendPasswordReset('a@b.com', 'tok_ABC-_');
    const input = provider.send.mock.calls[0]![0] as any;
    expect(input.from_addr).toBe('noreply@mail.example.org');
    expect(input.from_name).toBe('灵犀');
    expect(input.to).toEqual(['a@b.com']);
    expect(input.cc).toEqual([]);
    expect(input.subject).toBe('重置你的灵犀密码');
    expect(input.body_text).toContain('https://app.example.org/reset-password?token=tok_ABC-_');
    expect(input.body_text).toContain('30 分钟');
  });

  it('resetLinkBase: frontendBaseUrl 优先, 为空回落 publicBaseUrl, 去尾斜杠', () => {
    expect(resetLinkBase({ frontendBaseUrl: 'https://f.org/', publicBaseUrl: 'https://p.org' })).toBe('https://f.org');
    expect(resetLinkBase({ frontendBaseUrl: '', publicBaseUrl: 'https://p.org/' })).toBe('https://p.org');
  });

  it('logLinks=true 时把链接打到日志(dev 冒烟用)', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const m = makeSystemMailer({ provider: fakeProvider(), domain: 'd', linkBase: 'http://localhost:3000', logLinks: true });
    await m.sendPasswordReset('a@b.com', 'tok1');
    expect(spy.mock.calls.flat().join(' ')).toContain('http://localhost:3000/reset-password?token=tok1');
    spy.mockRestore();
  });
});
```

Run → Expected: FAIL

- [ ] **Step 2: 实现**

```ts
/**
 * 系统邮件(非 agent 邮箱): 目前只有找回密码。复用 EmailProvider 投递, 纯文本。
 * logLinks 由 EMAIL_PROVIDER=fake 决定(按 env 值切, 不按 NODE_ENV): dev 不真发信, 把链接打日志便于冒烟。
 */
import type { EmailProvider } from './provider.js';

export interface SystemMailer {
  sendPasswordReset(to: string, token: string): Promise<void>;
}

export const resetLinkBase = (cfg: { frontendBaseUrl: string; publicBaseUrl: string }): string =>
  (cfg.frontendBaseUrl || cfg.publicBaseUrl).replace(/\/+$/, '');

export const makeSystemMailer = (deps: {
  provider: EmailProvider;
  domain: string;
  linkBase: string;
  logLinks: boolean;
}): SystemMailer => ({
  async sendPasswordReset(to, token) {
    const link = `${deps.linkBase}/reset-password?token=${encodeURIComponent(token)}`;
    if (deps.logLinks) console.log(`[system-mailer] 重置链接 to=${to}: ${link}`);
    await deps.provider.send({
      from_addr: `noreply@${deps.domain}`,
      from_name: '灵犀',
      to: [to],
      cc: [],
      subject: '重置你的灵犀密码',
      body_text: [
        '你好，',
        '',
        '我们收到了重置你灵犀账号密码的请求。点击下面的链接设置新密码：',
        '',
        link,
        '',
        '该链接 30 分钟内有效，且只能使用一次。',
        '如果不是你本人操作，请忽略这封邮件，你的密码不会改变。',
        '',
        '— 灵犀',
      ].join('\n'),
    });
  },
});
```

> base64url token 只包含 `A-Za-z0-9-_`，`encodeURIComponent` 不会改变它，测试里的 `tok_ABC-_` 会原样出现在链接里。

- [ ] **Step 3: index.ts 共享 provider**

把 `index.ts:198` 块里的 `const emailProvider = getEmailProvider({...})` 挪到 `{` 块**之前**（仍在 `if (dbAvailable)` 内），块内继续用这个变量。紧接着构造：

```ts
    const systemMailer = makeSystemMailer({
      provider: emailProvider,
      domain: config.email.domain,
      linkBase: resetLinkBase(config.auth),
      logLinks: config.email.provider === 'fake',
    });
```

因为 `buildPasswordRoutes` 挂载在第 104 行，比这里早，所以要**把 emailProvider 和 systemMailer 的构造移到 `buildSessionRoutes` 之前**（第 96 行附近）。Task 6 会把 `systemMailer` 传给 `buildPasswordRoutes`。

先确认 `config.auth` 上有 `frontendBaseUrl` 和 `publicBaseUrl` 两个字段（`config.ts:28,31`）。

- [ ] **Step 4: 测试**

Run: `pnpm --filter @lingxi/gateway test && pnpm --filter @lingxi/gateway exec tsc --noEmit`
Expected: PASS（这一步 `systemMailer` 还没被使用，如果 tsc 报 unused 就先注释掉，Task 6 再接上）

- [ ] **Step 5: 检查点**（不提交）

---

### Task 6: 密码路由 — change / forgot / reset

**Files:**
- Modify: `apps/gateway/src/auth/password-routes.ts`、`apps/gateway/src/index.ts:104-108`
- Test: `apps/gateway/test/auth/password-routes.test.ts`

**Interfaces:**
- Consumes: `validateNewPassword`（T1）；`dao.users.*` 和 `dao.passwordResets.*`（T2）；`sessionVersions`、`issueSessionCookie`、`requireSession`（T3）；`authRateLimiter`（T4）；`SystemMailer`（T5）
- Produces: `PasswordRoutesOpts` 新增 `mailer: SystemMailer`；路由 `POST /api/auth/password/change|forgot|reset`

- [ ] **Step 1: 写失败测试**

在 `password-routes.test.ts` 里：
- 顶部新增 import：

  ```ts
  import { createHash } from 'node:crypto';
  import { authRateLimiter } from '../../src/lib/rate-limit.js';
  import { sessionVersions } from '../../src/auth/session-version.js';
  import { signSession, verifySession } from '../../src/auth/session.js';
  ```

- 把 `makeApp` 改成：

  ```ts
  const mailer = { sendPasswordReset: vi.fn(async () => {}) };
  const makeApp = () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(buildPasswordRoutes({ sessionSecret: SECRET, cookieName: COOKIE_NAME, ttlHours: 24, mailer }));
    return app;
  };
  const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
  const cookieFor = (userId: string, sv: number) => `${COOKIE_NAME}=${signSession({ user_id: userId, sv }, SECRET, 24)}`;
  const flush = () => new Promise((r) => setImmediate(r));
  ```

- 顶层 `beforeEach` 里追加：

  ```ts
    authRateLimiter.reset();
    sessionVersions.invalidate('u1');
  ```

- 注意：`vi.restoreAllMocks()` 会把 mock-dao 里 `vi.fn(impl)` 的默认实现重置掉，所以每个用例要自己设置 `getSessionVersion` 的返回值。

追加的测试块：

```ts
  describe('POST /api/auth/password/change', () => {
    const pwUser = () => ({ provider: 'password', password_hash: bcrypt.hashSync('oldpass12', 10) });

    it('成功: 写新 hash + sv+1 + 换发带新 sv 的 cookie', async () => {
      vi.mocked(dao.users.getSessionVersion).mockResolvedValue(0);
      vi.mocked(dao.users.getPasswordAuthById).mockResolvedValue(pwUser());
      vi.mocked(dao.users.updatePasswordAndBumpSession).mockResolvedValue(1);
      const res = await request(makeApp()).post('/api/auth/password/change')
        .set('Cookie', cookieFor('u1', 0))
        .send({ current_password: 'oldpass12', new_password: 'newpass12' });
      expect(res.status).toBe(200);
      const [uid, hash] = vi.mocked(dao.users.updatePasswordAndBumpSession).mock.calls[0]!;
      expect(uid).toBe('u1');
      expect(bcrypt.compareSync('newpass12', hash)).toBe(true);
      const setCookie = res.headers['set-cookie']!.find((c: string) => c.startsWith(`${COOKIE_NAME}=`))!;
      const jwt = setCookie.split(';')[0]!.slice(COOKIE_NAME.length + 1);
      expect(verifySession(jwt, SECRET).sv).toBe(1);
    });

    it('旧密码错 → 403 wrong_password, 不写库', async () => {
      vi.mocked(dao.users.getSessionVersion).mockResolvedValue(0);
      vi.mocked(dao.users.getPasswordAuthById).mockResolvedValue(pwUser());
      const res = await request(makeApp()).post('/api/auth/password/change')
        .set('Cookie', cookieFor('u1', 0))
        .send({ current_password: 'WRONG', new_password: 'newpass12' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('wrong_password');
      expect(dao.users.updatePasswordAndBumpSession).not.toHaveBeenCalled();
    });

    it('OAuth 用户 → 400 not_password_account', async () => {
      vi.mocked(dao.users.getSessionVersion).mockResolvedValue(0);
      vi.mocked(dao.users.getPasswordAuthById).mockResolvedValue({ provider: 'google', password_hash: null });
      const res = await request(makeApp()).post('/api/auth/password/change')
        .set('Cookie', cookieFor('u1', 0))
        .send({ current_password: 'x', new_password: 'newpass12' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('not_password_account');
    });

    it('新密码太短 → 400 password_too_short', async () => {
      vi.mocked(dao.users.getSessionVersion).mockResolvedValue(0);
      const res = await request(makeApp()).post('/api/auth/password/change')
        .set('Cookie', cookieFor('u1', 0))
        .send({ current_password: 'oldpass12', new_password: 'short' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('password_too_short');
    });

    it('未登录 → 401; 旧 sv 的 cookie → 401', async () => {
      expect((await request(makeApp()).post('/api/auth/password/change').send({})).status).toBe(401);
      vi.mocked(dao.users.getSessionVersion).mockResolvedValue(1);
      const res = await request(makeApp()).post('/api/auth/password/change')
        .set('Cookie', cookieFor('u1', 0))
        .send({ current_password: 'oldpass12', new_password: 'newpass12' });
      expect(res.status).toBe(401);
    });

    it('15 分钟内第 11 次 → 429 rate_limited', async () => {
      vi.mocked(dao.users.getSessionVersion).mockResolvedValue(0);
      vi.mocked(dao.users.getPasswordAuthById).mockResolvedValue(pwUser());
      const app = makeApp();
      for (let i = 0; i < 10; i++) {
        await request(app).post('/api/auth/password/change').set('Cookie', cookieFor('u1', 0))
          .send({ current_password: 'WRONG', new_password: 'newpass12' });
      }
      const res = await request(app).post('/api/auth/password/change').set('Cookie', cookieFor('u1', 0))
        .send({ current_password: 'oldpass12', new_password: 'newpass12' });
      expect(res.status).toBe(429);
      expect(res.body.code).toBe('rate_limited');
    });
  });

  describe('POST /api/auth/password/forgot', () => {
    const row = { id: 'u1', provider: 'password', external_id: 'a@b.com', email: 'a@b.com', nickname: null, avatar_url: null, password_hash: 'h', session_version: 0 };

    it('邮箱存在: 202 + 存 sha256 + 发信(原文 token 只进邮件)', async () => {
      vi.mocked(dao.users.getPasswordUserByEmail).mockResolvedValue(row);
      const res = await request(makeApp()).post('/api/auth/password/forgot').send({ email: 'a@b.com' });
      await flush();
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ ok: true });
      const [to, token] = mailer.sendPasswordReset.mock.calls[0]! as [string, string];
      expect(to).toBe('a@b.com');
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const created = vi.mocked(dao.passwordResets.create).mock.calls[0]![0];
      expect(created).toEqual({ userId: 'u1', tokenHash: sha256(token), ttlMinutes: 30 });
    });

    it('邮箱前后空格+大写也命中(查询用 trim 后的值)', async () => {
      vi.mocked(dao.users.getPasswordUserByEmail).mockResolvedValue(row);
      await request(makeApp()).post('/api/auth/password/forgot').send({ email: '  A@B.com ' });
      expect(vi.mocked(dao.users.getPasswordUserByEmail).mock.calls[0]![0]).toBe('A@B.com');
      // getPasswordUserByEmail 内部会 toLowerCase, 大小写由 DAO 处理
    });

    it('邮箱不存在 / 格式非法 / OAuth 用户: 响应与存在时完全一致, 不发信', async () => {
      vi.mocked(dao.users.getPasswordUserByEmail).mockResolvedValue(null); // OAuth 用户也查不到(只查 provider=password)
      for (const email of ['nobody@b.com', 'notanemail', '']) {
        const res = await request(makeApp()).post('/api/auth/password/forgot').send({ email });
        expect(res.status).toBe(202);
        expect(res.body).toEqual({ ok: true });
      }
      await flush();
      expect(mailer.sendPasswordReset).not.toHaveBeenCalled();
      expect(dao.passwordResets.create).not.toHaveBeenCalled();
    });

    it('同邮箱 60s 内第二次: 仍 202, 但不再发信', async () => {
      vi.mocked(dao.users.getPasswordUserByEmail).mockResolvedValue(row);
      const app = makeApp();
      await request(app).post('/api/auth/password/forgot').send({ email: 'a@b.com' });
      const res = await request(app).post('/api/auth/password/forgot').send({ email: 'a@b.com' });
      await flush();
      expect(res.status).toBe(202);
      expect(mailer.sendPasswordReset).toHaveBeenCalledTimes(1);
    });

    it('发信失败不影响 202', async () => {
      vi.mocked(dao.users.getPasswordUserByEmail).mockResolvedValue(row);
      mailer.sendPasswordReset.mockRejectedValueOnce(new Error('resend down'));
      const res = await request(makeApp()).post('/api/auth/password/forgot').send({ email: 'a@b.com' });
      await flush();
      expect(res.status).toBe(202);
    });
  });

  describe('POST /api/auth/password/reset', () => {
    it('成功: 消费 sha256(token) → 写 hash + sv+1 → 200', async () => {
      vi.mocked(dao.passwordResets.consume).mockResolvedValue('u1');
      vi.mocked(dao.users.updatePasswordAndBumpSession).mockResolvedValue(2);
      const res = await request(makeApp()).post('/api/auth/password/reset').send({ token: 'tok1', new_password: 'newpass12' });
      expect(res.status).toBe(200);
      expect(vi.mocked(dao.passwordResets.consume).mock.calls[0]![0]).toBe(sha256('tok1'));
      const [uid, hash] = vi.mocked(dao.users.updatePasswordAndBumpSession).mock.calls[0]!;
      expect(uid).toBe('u1');
      expect(bcrypt.compareSync('newpass12', hash)).toBe(true);
      expect(res.headers['set-cookie']).toBeUndefined(); // 不自动登录
    });

    it('token 首尾空白被 trim', async () => {
      vi.mocked(dao.passwordResets.consume).mockResolvedValue('u1');
      await request(makeApp()).post('/api/auth/password/reset').send({ token: '  tok1\n', new_password: 'newpass12' });
      expect(vi.mocked(dao.passwordResets.consume).mock.calls[0]![0]).toBe(sha256('tok1'));
    });

    it('无效/过期/已用 → 400 invalid_or_expired_token, 不写密码', async () => {
      vi.mocked(dao.passwordResets.consume).mockResolvedValue(null);
      const res = await request(makeApp()).post('/api/auth/password/reset').send({ token: 'tok1', new_password: 'newpass12' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_or_expired_token');
      expect(dao.users.updatePasswordAndBumpSession).not.toHaveBeenCalled();
    });

    it('新密码不合规时不消费 token(用户改个密码还能重试)', async () => {
      const res = await request(makeApp()).post('/api/auth/password/reset').send({ token: 'tok1', new_password: 'short' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('password_too_short');
      expect(dao.passwordResets.consume).not.toHaveBeenCalled();
    });

    it('空 token → 400 invalid_or_expired_token', async () => {
      const res = await request(makeApp()).post('/api/auth/password/reset').send({ token: '', new_password: 'newpass12' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_or_expired_token');
    });
  });
```

另外修改两处现有测试：
- 注册 / 登录成功的用例要 mock `getSessionVersion`（注册路径用 `issueSessionCookie` 从 store 取 sv）：在这两个用例里加 `vi.mocked(dao.users.getSessionVersion).mockResolvedValue(0);`。
- 登录用例里 `getPasswordUserByEmail` 的 mock 返回值补上 `session_version: 0`。

Run: `pnpm --filter @lingxi/gateway test -- test/auth/password-routes.test.ts`
Expected: FAIL（新路由不存在）

- [ ] **Step 2: 实现 password-routes.ts**

- 文件头注释补上三个新路由。
- import 改成：

  ```ts
  import { createHash, randomBytes } from 'node:crypto';
  import { validateNewPassword, type AuthErrorCode } from '@lingxi/shared';
  import { requireSession } from './middleware.js';
  import { issueSessionCookie, sessionVersions } from './session-version.js';
  import { authRateLimiter } from '../lib/rate-limit.js';
  import type { SystemMailer } from '../lib/email/system-mailer.js';
  ```

  删掉 `signSession, sessionCookieOpts` 和 `MIN_PASSWORD_LENGTH` 的 import。
- `PasswordRoutesOpts` 加 `mailer: SystemMailer;`
- 删除 `setSessionCookie`，register / login 改成 `await issueSessionCookie(res, id, opts)`。login 可以直接传 `row.session_version` 作为第 4 个参数，省一次查询。
- register 的长度校验改成：

  ```ts
  const pwErr = validateNewPassword(password);
  if (pwErr) return fail(res, 400, pwErr, pwErr.replace(/_/g, ' '));
  ```

- 在 `buildPasswordRoutes` 里、`return r` 之前加：

```ts
  const sessionMw = requireSession({ secret: opts.sessionSecret, cookieName: opts.cookieName, versions: sessionVersions });
  const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
  const RESET_TTL_MINUTES = 30;
  const MIN = 60_000;
  const HOUR = 3_600_000;

  r.post('/api/auth/password/change', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const current = String(req.body?.current_password ?? '');
    const next = String(req.body?.new_password ?? '');
    const pwErr = validateNewPassword(next);
    if (pwErr) return fail(res, 400, pwErr, pwErr.replace(/_/g, ' '));
    if (!authRateLimiter.hit(`change:user:${userId}`, 10, 15 * MIN)) {
      return fail(res, 429, 'rate_limited', 'too many attempts');
    }
    try {
      const auth = await dao.users.getPasswordAuthById(userId);
      if (!auth || auth.provider !== 'password' || !auth.password_hash) {
        return fail(res, 400, 'not_password_account', 'not a password account');
      }
      if (!(await bcrypt.compare(current, auth.password_hash))) {
        return fail(res, 403, 'wrong_password', 'current password incorrect');
      }
      const hash = await bcrypt.hash(next, BCRYPT_ROUNDS);
      const sv = await dao.users.updatePasswordAndBumpSession(userId, hash);
      if (sv === null) return res.status(500).json({ error: 'user vanished' });
      sessionVersions.invalidate(userId);
      await issueSessionCookie(res, userId, opts, sv);
      console.log(`[password-routes] auth.password.change user=${userId} sv=${sv}`);
      res.json({ ok: true });
    } catch (err) {
      console.error('[password-routes] change failed:', err);
      res.status(500).json({ error: 'internal' });
    }
  });

  r.post('/api/auth/password/forgot', async (req: Request, res: Response) => {
    const email = String(req.body?.email ?? '').trim();
    // 无论命中与否都立即回 202, 后续全部异步, 响应时间不泄露邮箱是否注册。
    res.status(202).json({ ok: true });

    if (!EMAIL_RE.test(email)) return;
    const key = email.toLowerCase();
    const allowed = authRateLimiter.hit(`forgot:ip:${req.ip}`, 20, HOUR)
      && authRateLimiter.hit(`forgot:email:1m:${key}`, 1, MIN)
      && authRateLimiter.hit(`forgot:email:1h:${key}`, 5, HOUR);
    if (!allowed) {
      console.warn(`[password-routes] auth.password.forgot rate_limited ip=${req.ip}`);
      return;
    }
    try {
      const row = await dao.users.getPasswordUserByEmail(email);
      console.log(`[password-routes] auth.password.forgot matched=${!!row}`);
      if (!row || !row.email) return;
      const token = randomBytes(32).toString('base64url');
      await dao.passwordResets.create({ userId: row.id, tokenHash: sha256(token), ttlMinutes: RESET_TTL_MINUTES });
      await opts.mailer.sendPasswordReset(row.email, token);
    } catch (err) {
      console.error('[password-routes] forgot failed (已回 202, 仅记录):', err);
    }
  });

  r.post('/api/auth/password/reset', async (req: Request, res: Response) => {
    const token = String(req.body?.token ?? '').trim();
    const next = String(req.body?.new_password ?? '');
    if (!token) return fail(res, 400, 'invalid_or_expired_token', 'missing token');
    // 先校验新密码再消费 token: 密码不合规时 token 还能留着重试。
    const pwErr = validateNewPassword(next);
    if (pwErr) return fail(res, 400, pwErr, pwErr.replace(/_/g, ' '));
    if (!authRateLimiter.hit(`reset:ip:${req.ip}`, 20, HOUR)) {
      return fail(res, 429, 'rate_limited', 'too many attempts');
    }
    try {
      const userId = await dao.passwordResets.consume(sha256(token));
      if (!userId) return fail(res, 400, 'invalid_or_expired_token', 'invalid or expired token');
      const hash = await bcrypt.hash(next, BCRYPT_ROUNDS);
      const sv = await dao.users.updatePasswordAndBumpSession(userId, hash);
      sessionVersions.invalidate(userId);
      console.log(`[password-routes] auth.password.reset user=${userId} sv=${sv}`);
      res.json({ ok: true });
    } catch (err) {
      console.error('[password-routes] reset failed:', err);
      res.status(500).json({ error: 'internal' });
    }
  });
```

> 说明：`forgot` 先回 202 再做异步工作，后面这些 await 不会阻塞响应；异常在 catch 里只记日志，不会产生 unhandledRejection。邮件里用的是 `row.email`（数据库里存的原始邮箱），不是用户刚输入的那个。

- [ ] **Step 3: index.ts 传 mailer**

`buildPasswordRoutes({ ..., mailer: systemMailer })`（`systemMailer` 在 Task 5 已经构造好，并且挪到了这行之前）。

- [ ] **Step 4: 测试**

Run: `pnpm --filter @lingxi/gateway test && pnpm --filter @lingxi/gateway exec tsc --noEmit`
Expected: 全部 PASS

- [ ] **Step 5: 检查点**（不提交）

---

### Task 7: Web 前端

**Files:**
- Modify: `apps/web/src/lib/api.ts`（login / register 附近）、`apps/web/src/App.tsx`、`apps/web/src/auth/LoginPage.tsx`、`apps/web/src/desktop/Menubar.tsx`
- Create: `apps/web/src/auth/passwordErrors.ts`、`apps/web/src/auth/ForgotPasswordPage.tsx`、`apps/web/src/auth/ResetPasswordPage.tsx`、`apps/web/src/desktop/ChangePasswordDialog.tsx`
- Test: `apps/web/src/auth/ResetPasswordPage.test.tsx`、`apps/web/src/desktop/ChangePasswordDialog.test.tsx`

**Interfaces:**
- Consumes: `validateNewPassword`、`PasswordChangeRequest` / `PasswordForgotRequest` / `PasswordResetRequest`（T1）；后端三个路由（T6）
- Produces:
  - `api.changePassword(body): Promise<{ok:true}>`
  - `api.forgotPassword(body): Promise<{ok:true}>`
  - `api.resetPassword(body): Promise<{ok:true}>`
  - `passwordErrorMessage(e: unknown, fallback: string): string`

- [ ] **Step 1: api.ts + 错误文案**

`api.ts` 在 `register` 后面加（同时把三个类型加进文件顶部现有的 `@lingxi/shared` import）：

```ts
export const changePassword = (body: PasswordChangeRequest): Promise<{ ok: true }> =>
  submitJson('/api/auth/password/change', body);

export const forgotPassword = (body: PasswordForgotRequest): Promise<{ ok: true }> =>
  submitJson('/api/auth/password/forgot', body);

export const resetPassword = (body: PasswordResetRequest): Promise<{ ok: true }> =>
  submitJson('/api/auth/password/reset', body);
```

`apps/web/src/auth/passwordErrors.ts`：

```ts
import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_BYTES } from '@lingxi/shared';
import { ApiError } from '../lib/api.js';

/** 密码类错误码 → 中文。未知错误透出真实信息。 */
export const passwordErrorMessage = (e: unknown, fallback: string): string => {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'password_too_short': return `密码至少 ${MIN_PASSWORD_LENGTH} 位`;
      case 'password_too_long': return `密码过长（最多 ${MAX_PASSWORD_BYTES} 字节，约 ${MAX_PASSWORD_BYTES / 3} 个汉字）`;
      case 'wrong_password': return '当前密码不正确';
      case 'not_password_account': return '该账号通过第三方登录，没有密码';
      case 'invalid_or_expired_token': return '链接无效或已过期';
      case 'rate_limited': return '尝试过于频繁，请稍后再试';
      default: return `${fallback}：${e.message}`;
    }
  }
  return fallback;
};

/** 前端即时校验: 返回错误文案或 null。 */
export const newPasswordProblem = (pw: string, confirm: string, validate: (p: string) => string | null): string | null => {
  const code = validate(pw);
  if (code === 'password_too_short') return `密码至少 ${MIN_PASSWORD_LENGTH} 位`;
  if (code === 'password_too_long') return `密码过长（最多 ${MAX_PASSWORD_BYTES} 字节）`;
  if (pw !== confirm) return '两次输入的新密码不一致';
  return null;
};
```

`LoginPage.tsx` 的 `authErrorMessage` 里加一行 `case 'password_too_long': return '密码过长';`；客户端校验改成 `validateNewPassword(password)`，不再手写长度判断。

- [ ] **Step 2: 写失败测试** `apps/web/src/desktop/ChangePasswordDialog.test.tsx`

```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as api from '../lib/api.js';
import { ChangePasswordDialog } from './ChangePasswordDialog.js';

const fill = (label: string, v: string) => fireEvent.change(screen.getByPlaceholderText(label), { target: { value: v } });

describe('ChangePasswordDialog', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('两次新密码不一致 → 前端拦截, 不调接口', async () => {
    const spy = vi.spyOn(api, 'changePassword');
    render(<ChangePasswordDialog onClose={vi.fn()} />);
    fill('当前密码', 'oldpass12'); fill('新密码', 'newpass12'); fill('确认新密码', 'newpass13');
    fireEvent.click(screen.getByRole('button', { name: '确认修改' }));
    expect(await screen.findByText('两次输入的新密码不一致')).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it('后端 403 → 显示"当前密码不正确"', async () => {
    vi.spyOn(api, 'changePassword').mockRejectedValue(new api.ApiError(403, 'wrong_password', 'x'));
    render(<ChangePasswordDialog onClose={vi.fn()} />);
    fill('当前密码', 'bad'); fill('新密码', 'newpass12'); fill('确认新密码', 'newpass12');
    fireEvent.click(screen.getByRole('button', { name: '确认修改' }));
    expect(await screen.findByText('当前密码不正确')).toBeInTheDocument();
  });

  it('成功 → 显示成功提示', async () => {
    vi.spyOn(api, 'changePassword').mockResolvedValue({ ok: true });
    render(<ChangePasswordDialog onClose={vi.fn()} />);
    fill('当前密码', 'oldpass12'); fill('新密码', 'newpass12'); fill('确认新密码', 'newpass12');
    fireEvent.click(screen.getByRole('button', { name: '确认修改' }));
    await waitFor(() => expect(screen.getByText('密码已修改，其他设备已退出登录')).toBeInTheDocument());
  });
});
```

`apps/web/src/auth/ResetPasswordPage.test.tsx`：

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as api from '../lib/api.js';
import { ResetPasswordPage } from './ResetPasswordPage.js';

const renderAt = (url: string) => render(
  <MemoryRouter initialEntries={[url]}>
    <Routes>
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/login" element={<div>LOGIN_PAGE</div>} />
    </Routes>
  </MemoryRouter>,
);
const fill = (label: string, v: string) => fireEvent.change(screen.getByPlaceholderText(label), { target: { value: v } });

describe('ResetPasswordPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('URL 无 token → 直接提示链接无效 + 重新申请入口', () => {
    renderAt('/reset-password');
    expect(screen.getByText('链接无效或已过期')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '重新申请' })).toHaveAttribute('href', '/forgot-password');
  });

  it('成功 → 带 token 调接口并跳登录页', async () => {
    const spy = vi.spyOn(api, 'resetPassword').mockResolvedValue({ ok: true });
    renderAt('/reset-password?token=tok1');
    fill('新密码', 'newpass12'); fill('确认新密码', 'newpass12');
    fireEvent.click(screen.getByRole('button', { name: '设置新密码' }));
    expect(await screen.findByText('LOGIN_PAGE')).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith({ token: 'tok1', new_password: 'newpass12' });
  });

  it('token 过期 → 显示错误 + 重新申请', async () => {
    vi.spyOn(api, 'resetPassword').mockRejectedValue(new api.ApiError(400, 'invalid_or_expired_token', 'x'));
    renderAt('/reset-password?token=tok1');
    fill('新密码', 'newpass12'); fill('确认新密码', 'newpass12');
    fireEvent.click(screen.getByRole('button', { name: '设置新密码' }));
    expect(await screen.findByText('链接无效或已过期')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '重新申请' })).toBeInTheDocument();
  });
});
```

Run: `pnpm --filter web test`
Expected: FAIL（组件不存在）

> 如果 `vi.spyOn(api, ...)` 因为 ESM namespace 不可写而失败，改用文件顶部 `vi.mock('../lib/api.js', async (orig) => ({ ...(await orig()), changePassword: vi.fn(), resetPassword: vi.fn() }))`，再用 `vi.mocked(api.changePassword)` 设置返回值。先看现有的 `Dock.test.tsx` 用的是哪种写法，跟着它。

- [ ] **Step 3: 实现组件**

共用的卡片 / 输入框样式直接复制 `LoginPage` 里的 `inputStyle` 和卡片容器（`card fade` + `Wallpaper`）。不抽公共组件，保持和现有页面一致（YAGNI）。

`apps/web/src/desktop/ChangePasswordDialog.tsx`：

```tsx
import { useState, type FormEvent } from 'react';
import { validateNewPassword } from '@lingxi/shared';
import * as api from '../lib/api.js';
import { passwordErrorMessage, newPasswordProblem } from '../auth/passwordErrors.js';

const inputStyle = {
  width: '100%', padding: '10px 12px', fontSize: 14,
  border: '1px solid var(--border)', borderRadius: 10, outline: 'none',
  boxSizing: 'border-box' as const,
};

/** 修改密码弹窗(仅 password 账号可见, 入口在 Menubar 账号下拉)。 */
export const ChangePasswordDialog = ({ onClose }: { onClose: () => void }) => {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const problem = newPasswordProblem(next, confirm, validateNewPassword);
    if (problem) { setError(problem); return; }
    setBusy(true);
    try {
      await api.changePassword({ current_password: current, new_password: next });
      setDone(true);
    } catch (err) {
      console.error('[ChangePasswordDialog] change failed:', err);
      setError(passwordErrorMessage(err, '修改失败'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3000 }}
    >
      <div
        className="card fade"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 360, padding: 24, background: 'var(--panel)', borderRadius: 16, boxShadow: 'var(--shadow-l)' }}
      >
        <div style={{ fontSize: 16, fontWeight: 650, marginBottom: 14 }}>修改密码</div>
        {done ? (
          <>
            <div style={{ fontSize: 13.5, marginBottom: 16 }}>密码已修改，其他设备已退出登录</div>
            <button type="button" onClick={onClose} style={{ width: '100%', padding: 10, borderRadius: 10, border: 'none', background: '#7c3aed', color: '#fff', fontWeight: 600 }}>完成</button>
          </>
        ) : (
          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input type="password" placeholder="当前密码" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} style={inputStyle} />
            <input type="password" placeholder="新密码" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} style={inputStyle} />
            <input type="password" placeholder="确认新密码" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} style={inputStyle} />
            {error && <div style={{ color: '#dc2626', fontSize: 12.5 }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <button type="button" onClick={onClose} style={{ flex: 1, padding: 10, borderRadius: 10, border: '1px solid var(--border)', background: 'transparent' }}>取消</button>
              <button type="submit" disabled={busy} style={{ flex: 1, padding: 10, borderRadius: 10, border: 'none', background: '#7c3aed', color: '#fff', fontWeight: 600, opacity: busy ? 0.6 : 1 }}>确认修改</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
```

`apps/web/src/auth/ForgotPasswordPage.tsx`：

```tsx
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Wallpaper } from '../lib/Wallpaper.js';
import * as api from '../lib/api.js';
import { passwordErrorMessage } from './passwordErrors.js';

const inputStyle = {
  width: '100%', padding: '10px 12px', fontSize: 14,
  border: '1px solid var(--border)', borderRadius: 10, outline: 'none',
  boxSizing: 'border-box' as const,
};

/** 找回密码: 填邮箱 → 统一提示(不泄露邮箱是否注册)。 */
export const ForgotPasswordPage = () => {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.forgotPassword({ email: email.trim() });
      setSent(true);
    } catch (err) {
      console.error('[ForgotPasswordPage] failed:', err);
      setError(passwordErrorMessage(err, '提交失败，请重试'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
      <Wallpaper />
      <div className="card fade" style={{ width: 380, padding: 28, background: 'rgba(255,255,255,0.86)', backdropFilter: 'blur(30px)', borderRadius: 20, position: 'relative', zIndex: 2 }}>
        <div style={{ fontSize: 17, fontWeight: 650, marginBottom: 6 }}>找回密码</div>
        {sent ? (
          <div style={{ fontSize: 13.5, lineHeight: 1.6, margin: '12px 0 18px' }}>
            如果该邮箱已注册，你会收到一封重置邮件，请在 30 分钟内完成。没收到请检查垃圾邮件箱。
          </div>
        ) : (
          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
            <input placeholder="注册邮箱" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} style={inputStyle} />
            {error && <div style={{ color: '#dc2626', fontSize: 12.5 }}>{error}</div>}
            <button type="submit" disabled={busy || !email.trim()} style={{ width: '100%', padding: 11, marginTop: 8, fontSize: 14, fontWeight: 600, border: 'none', borderRadius: 10, background: '#7c3aed', color: '#fff', opacity: busy ? 0.6 : 1 }}>发送重置邮件</button>
          </form>
        )}
        <div style={{ marginTop: 14, fontSize: 12.5 }}><Link to="/login">返回登录</Link></div>
      </div>
    </div>
  );
};
```

`apps/web/src/auth/ResetPasswordPage.tsx`：

```tsx
import { useState, useEffect, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { validateNewPassword } from '@lingxi/shared';
import { Wallpaper } from '../lib/Wallpaper.js';
import * as api from '../lib/api.js';
import { passwordErrorMessage, newPasswordProblem } from './passwordErrors.js';

const inputStyle = {
  width: '100%', padding: '10px 12px', fontSize: 14,
  border: '1px solid var(--border)', borderRadius: 10, outline: 'none',
  boxSizing: 'border-box' as const,
};

/** 邮件链接落地页: /reset-password?token=… → 设新密码 → 跳登录。 */
export const ResetPasswordPage = () => {
  const [params] = useSearchParams();
  // 只在首次渲染读一次 token, 随后把它从地址栏抹掉(避免进浏览器历史 / Referer)。
  const [token] = useState(() => params.get('token')?.trim() ?? '');
  const nav = useNavigate();
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(token ? '' : '链接无效或已过期');
  const [expired, setExpired] = useState(!token);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (token) window.history.replaceState(null, '', '/reset-password');
  }, [token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const problem = newPasswordProblem(next, confirm, validateNewPassword);
    if (problem) { setError(problem); return; }
    setBusy(true);
    try {
      await api.resetPassword({ token, new_password: next });
      nav('/login', { replace: true, state: { notice: '密码已重置，请登录' } });
    } catch (err) {
      console.error('[ResetPasswordPage] failed:', err);
      if (err instanceof api.ApiError && err.code === 'invalid_or_expired_token') setExpired(true);
      setError(passwordErrorMessage(err, '重置失败'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
      <Wallpaper />
      <div className="card fade" style={{ width: 380, padding: 28, background: 'rgba(255,255,255,0.86)', backdropFilter: 'blur(30px)', borderRadius: 20, position: 'relative', zIndex: 2 }}>
        <div style={{ fontSize: 17, fontWeight: 650, marginBottom: 12 }}>设置新密码</div>
        {!expired && (
          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input type="password" placeholder="新密码" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} style={inputStyle} />
            <input type="password" placeholder="确认新密码" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} style={inputStyle} />
            {error && <div style={{ color: '#dc2626', fontSize: 12.5 }}>{error}</div>}
            <button type="submit" disabled={busy} style={{ width: '100%', padding: 11, marginTop: 8, fontSize: 14, fontWeight: 600, border: 'none', borderRadius: 10, background: '#7c3aed', color: '#fff', opacity: busy ? 0.6 : 1 }}>设置新密码</button>
          </form>
        )}
        {expired && (
          <>
            <div style={{ color: '#dc2626', fontSize: 13.5, marginBottom: 12 }}>{error}</div>
            <Link to="/forgot-password">重新申请</Link>
          </>
        )}
      </div>
    </div>
  );
};
```

- [ ] **Step 4: 入口和路由**

`App.tsx` 加两条公开路由（放在 `/login` 后面）：

```tsx
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
```

并 import 这两个组件。

`LoginPage.tsx`：
- 在密码 `<input>` 和 `{error && ...}` 之间加（只在登录模式显示）：

  ```tsx
  {mode === 'login' && (
    <div style={{ textAlign: 'right', fontSize: 12 }}>
      <Link to="/forgot-password" className="dim">忘记密码？</Link>
    </div>
  )}
  ```

  `Link` 从 `react-router-dom` 引入。
- 读取 `useLocation().state?.notice`：有值时在表单上方显示一行绿色提示（`color: '#16a34a', fontSize: 12.5`）。

`Menubar.tsx`：
- 加 `const [pwOpen, setPwOpen] = useState(false);`
- 在分隔线 `<div style={{ height: 1 ...` 和「退出登录」按钮之间加：

  ```tsx
  {user.provider === 'password' && (
    <button
      onClick={() => { setAccountOpen(false); setPwOpen(true); }}
      style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 11, padding: '8px 10px', borderRadius: 9, fontSize: 13.5 }}
    >
      <IconUser size={16} /> 修改密码
    </button>
  )}
  ```

- 在最外层 `</div>` 之前加 `{pwOpen && <ChangePasswordDialog onClose={() => setPwOpen(false)} />}`，并 import 组件。
- 如果 `icons.tsx` 里有锁形图标（`grep -n "export const Icon" apps/web/src/lib/icons.tsx`），优先用它替代 `IconUser`。

- [ ] **Step 5: 测试 + build**

Run: `pnpm --filter web test && pnpm --filter web build`
Expected: test 全部 PASS，build 成功（lint 不作为通过门）

- [ ] **Step 6: 检查点**（不提交）

---

### Task 8: 端到端冒烟（本地）

**Files:** 无代码改动。发现的问题回到对应 Task 修复。

- [ ] **Step 1: 全量测试 + build**

Run: `cd /Users/yanjiayi/workspace/laifu && pnpm build && pnpm --filter @lingxi/gateway test && pnpm --filter web test && pnpm --filter @lingxi/shared test`
Expected: 全部绿

- [ ] **Step 2: 起本地环境**

Run: `pnpm dev:check && pnpm dev`（后台跑）。本地 `EMAIL_PROVIDER` 应该是 `fake`，用 `grep EMAIL_PROVIDER apps/gateway/.env.local` 确认。
Expected: gateway :9000、web :3000 都起来，日志无报错。

- [ ] **Step 3: 用 curl 走后端全流程**（cookie jar 模拟两台设备）

```bash
B=http://localhost:9000
E=smoke-$(date +%s)@example.com
curl -s -c a.jar -X POST $B/api/auth/password/register -H 'content-type: application/json' -d "{\"email\":\"$E\",\"password\":\"oldpass12\"}"
curl -s -c b.jar -X POST $B/api/auth/password/login    -H 'content-type: application/json' -d "{\"email\":\"$E\",\"password\":\"oldpass12\"}"
curl -s -b a.jar -c a.jar -X POST $B/api/auth/password/change -H 'content-type: application/json' -d '{"current_password":"oldpass12","new_password":"newpass12"}'   # 期望 {"ok":true}
curl -s -o /dev/null -w '%{http_code}\n' -b a.jar $B/api/auth/me   # 期望 200 (当前设备换发了新 cookie)
sleep 31; curl -s -o /dev/null -w '%{http_code}\n' -b b.jar $B/api/auth/me   # 期望 401 (另一设备被踢; 30s 缓存过后)
curl -s -o /dev/null -w '%{http_code}\n' -X POST $B/api/auth/password/forgot -H 'content-type: application/json' -d "{\"email\":\"$E\"}"   # 期望 202
# 从 gateway 日志找 "[system-mailer] 重置链接" 那行, 取出 token=XXXX
T=<token>
curl -s -X POST $B/api/auth/password/reset -H 'content-type: application/json' -d "{\"token\":\"$T\",\"new_password\":\"reset123x\"}"   # 期望 {"ok":true}
curl -s -X POST $B/api/auth/password/reset -H 'content-type: application/json' -d "{\"token\":\"$T\",\"new_password\":\"reset123x\"}"   # 期望 400 invalid_or_expired_token (一次性)
curl -s -o /dev/null -w '%{http_code}\n' -X POST $B/api/auth/password/login -H 'content-type: application/json' -d "{\"email\":\"$E\",\"password\":\"reset123x\"}"   # 期望 200
```

> `sleep 31` 是这里用 Bash 前台 sleep；如果被禁，改成 Monitor 或拆成两次调用。

**并发消费验证**（真实 PG 原子性）：再申请一次 forgot 拿到新 token，然后同时发两个 reset：

```bash
for i in 1 2; do curl -s -X POST $B/api/auth/password/reset -H 'content-type: application/json' -d "{\"token\":\"$T2\",\"new_password\":\"concur12x\"}" & done; wait
```

Expected：一个 `{"ok":true}`，一个 `invalid_or_expired_token`。

- [ ] **Step 4: 浏览器走前端**（用 run 技能或手工操作；Review Focus #5）

1. 打开 http://localhost:3000/login，确认「忘记密码？」链接可见，点进去走一遍 forgot。
2. 打开日志里的重置链接：地址栏应该立即变成 `/reset-password`（token 被抹掉）。设置新密码后跳到登录页，并显示「密码已重置，请登录」。
3. 登录后，账号下拉菜单里有「修改密码」；Google 账号看不到这一项。
4. 两个浏览器（或一个普通窗口 + 一个隐身窗口）都登录同一账号，在 A 里改密码，等 30 秒后刷新 B：**B 应该跳到 /login，不能白屏**。

- [ ] **Step 5: 停服、汇报**

停掉 `pnpm dev`，删除 `a.jar b.jar`。按实际结果汇报：每一步的期望值和实际值、失败项和失败输出。**不要部署**。prod 迁移（`DATABASE_URL=<prod> pnpm --filter @lingxi/db db:migrate`）和部署要先由用户另行批准。

---

## 上线（不在本计划执行范围内，供用户审批）

1. prod 迁移：`cd packages/db && DATABASE_URL=$(az keyvault secret show --vault-name kv-lingxi-prod -n database-url --query value -o tsv) pnpm db:migrate`。迁移与旧代码兼容。
2. 部署：`./scripts/build-deploy.sh` → zip → `az webapp deploy -g rg-lingxi-prod -n app-lingxi-prod-gateway ...`
3. 线上验证：用测试账号走一遍 forgot，确认 `noreply@mail.laifu.uncagedai.org` 投递成功、不进垃圾箱（检查 SPF / DKIM）。
