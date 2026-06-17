# 账号密码登录 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增邮箱+密码注册/登录作为主要登录方式,Google OAuth 降级为登录页下方次要入口。

**Architecture:** 密码登录走专用 POST 路由(非 OAuth redirect 流程),复用现有 `users` 表(新增 `password_hash` 列,`provider='password'`/`external_id=lower(email)`)、JWT session 签发、`requireSession` middleware、`/api/auth/me` 与 `/api/auth/logout`。前端 LoginPage 改为登录/注册 tab 表单,Google 移到下方。

**Tech Stack:** TypeScript, Express, Drizzle (Postgres/Supabase), bcryptjs, React + Vite, Vitest + supertest + @testing-library/react。

**Spec:** `docs/superpowers/specs/2026-06-17-account-password-login-design.md`

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `packages/db/src/schema.ts` | users 表加 `password_hash` 列 | 改 |
| `packages/db/drizzle/<新>.sql` | 迁移 SQL | drizzle-kit 生成 |
| `apps/gateway/src/db/users-dao.ts` | `createPasswordUser` / `getPasswordUserByEmail` | 改 |
| `apps/gateway/test/helpers/mock-dao.ts` | mock 加两个新方法 | 改 |
| `packages/shared/src/contracts.ts` | `PasswordLoginRequest` / `PasswordRegisterRequest` | 改 |
| `apps/gateway/src/auth/password-routes.ts` | register/login handler | 新建 |
| `apps/gateway/test/auth/password-routes.test.ts` | 后端路由测试 | 新建 |
| `apps/gateway/src/index.ts` | 挂载 password router | 改 |
| `apps/web/src/lib/api.ts` | `login` / `register` 前端调用 | 改 |
| `apps/web/src/auth/LoginPage.tsx` | tab 表单 + Google 下移 | 重写 |
| `apps/web/test/LoginPage.test.tsx` | 前端登录页测试 | 改 |

约定:gateway 测试用 `vi.mock('../../src/db/index.js')` + `mock-dao.ts`,supertest 打 express app(见 `oauth-router.test.ts`)。前端测试用 `@testing-library/react` + `MemoryRouter` + `WithStore`(见现有 `LoginPage.test.tsx`)。

---

## Task 1: users 表加 password_hash 列 + 迁移

**Files:**
- Modify: `packages/db/src/schema.ts:18-31`(users 表定义)
- Generate: `packages/db/drizzle/<新迁移>.sql`

- [ ] **Step 1: 改 schema 加列**

在 `packages/db/src/schema.ts` 的 `users` 表定义里,`token_version` 行之后、`created_at` 之前加一列:

```ts
  token_version: integer('token_version').notNull().default(0),
  password_hash: text('password_hash'),   // 仅 provider='password' 用户有值;OAuth 用户为 null
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
```

- [ ] **Step 2: 生成迁移**

Run: `pnpm --filter @lingxi/db db:generate`
Expected: `packages/db/drizzle/` 下新增一个 `*.sql`,内容含 `ALTER TABLE "users" ADD COLUMN "password_hash" text;`

- [ ] **Step 3: 校验迁移内容**

Run: `ls -t packages/db/drizzle/*.sql | head -1 | xargs grep -i password_hash`
Expected: 打印出 `ADD COLUMN "password_hash" text` 一行。若没生成,手动确认 schema 改动已保存后重跑 Step 2。

- [ ] **Step 4: 落库到本地 dev**

Run: `pnpm --filter @lingxi/db db:migrate`
Expected: 迁移成功,无报错(本地 PG 须已起,见 `./scripts/dev-db.sh`)。

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle
git commit -m "feat(db): users 表加 password_hash 列(账号密码登录)"
```

---

## Task 2: shared contracts 加密码登录请求类型

**Files:**
- Modify: `packages/shared/src/contracts.ts`(`AuthMeResponse` 定义附近,约 :83)

- [ ] **Step 1: 加两个 request 类型**

在 `packages/shared/src/contracts.ts` 里 `AuthMeResponse` interface 之后,加:

```ts
/** 账号密码登录请求 */
export interface PasswordLoginRequest {
  email: string;
  password: string;
}

/** 账号密码注册请求 */
export interface PasswordRegisterRequest {
  email: string;
  password: string;
  nickname: string;
}
```

- [ ] **Step 2: build shared 验证类型导出**

Run: `pnpm --filter @lingxi/shared build`
Expected: 编译通过。确认 `packages/shared/dist/contracts.d.ts` 含 `PasswordLoginRequest`。

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/contracts.ts packages/shared/dist
git commit -m "feat(shared): 加 PasswordLoginRequest/PasswordRegisterRequest 契约"
```

---

## Task 3: users-dao 加 createPasswordUser / getPasswordUserByEmail

**Files:**
- Modify: `apps/gateway/src/db/users-dao.ts`
- Modify: `apps/gateway/test/helpers/mock-dao.ts:11-15`(users mock 加两方法)
- Test: `apps/gateway/test/db/users-dao.test.ts`(若不存在则新建)

DAO 单元测试需要真实 db,本仓 gateway 测试约定是 mock dao 而非连库。因此 **DAO 行为通过 Task 5 的路由测试覆盖**(mock dao 返回值驱动),这里只加实现 + 更新 mock helper,不单独写连库测试。

- [ ] **Step 1: 扩展 UsersDao 接口**

在 `apps/gateway/src/db/users-dao.ts` 的 `UsersDao` interface 里(`upsertByProvider` 之后)加:

```ts
  createPasswordUser(input: {
    email: string;
    nickname: string;
    hash: string;
  }): Promise<{ id: string } | null>;
  getPasswordUserByEmail(email: string): Promise<(UserRow & { password_hash: string | null }) | null>;
```

- [ ] **Step 2: 实现两个方法**

在 `makeUsersDao` 返回对象里(`upsertByProvider` 之后)加。`onConflictDoNothing().returning()` 返回空数组即代表邮箱已占用(由全局 `lower(email)` 唯一索引或 `(provider,external_id)` 唯一约束触发):

```ts
    async createPasswordUser({ email, nickname, hash }) {
      const rows = await db.insert(u).values({
        provider: 'password',
        external_id: email.toLowerCase(),
        email,
        nickname,
        password_hash: hash,
      }).onConflictDoNothing().returning({ id: u.id });
      return rows[0] ?? null;  // null = 邮箱已存在
    },

    async getPasswordUserByEmail(email) {
      const rows = await db.select({
        id: u.id,
        provider: u.provider,
        external_id: u.external_id,
        email: u.email,
        nickname: u.nickname,
        avatar_url: u.avatar_url,
        password_hash: u.password_hash,
      }).from(u)
        .where(and(eq(u.provider, 'password'), eq(u.external_id, email.toLowerCase())))
        .limit(1);
      return rows[0] ?? null;
    },
```

> 注:`and`、`eq` 已在文件顶部 `import { eq, and } from 'drizzle-orm'` 导入。`u.password_hash` 依赖 Task 1 的 schema 列。

- [ ] **Step 3: 更新 mock-dao helper**

在 `apps/gateway/test/helpers/mock-dao.ts` 的 `users` 块里(`upsertByProvider` 之后)加:

```ts
    upsertByProvider: vi.fn(async () => null),
    createPasswordUser: vi.fn(async () => ({ id: 'u_new' })),
    getPasswordUserByEmail: vi.fn(async () => null),
```

- [ ] **Step 4: 类型检查 gateway**

Run: `pnpm --filter @lingxi/gateway build`
Expected: 编译通过(确认接口与实现签名一致)。

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/db/users-dao.ts apps/gateway/test/helpers/mock-dao.ts
git commit -m "feat(gateway): users-dao 加 createPasswordUser/getPasswordUserByEmail"
```

---

## Task 4: 加 bcryptjs 依赖

**Files:**
- Modify: `apps/gateway/package.json`

- [ ] **Step 1: 安装依赖**

Run: `pnpm --filter @lingxi/gateway add bcryptjs && pnpm --filter @lingxi/gateway add -D @types/bcryptjs`
Expected: `apps/gateway/package.json` 的 dependencies 出现 `bcryptjs`,devDependencies 出现 `@types/bcryptjs`。

- [ ] **Step 2: 验证可导入**

Run: `cd apps/gateway && node -e "const b=require('bcryptjs'); console.log(typeof b.hashSync)" && cd ../..`
Expected: 打印 `function`。

- [ ] **Step 3: Commit**

```bash
git add apps/gateway/package.json pnpm-lock.yaml
git commit -m "chore(gateway): 加 bcryptjs 依赖(密码哈希)"
```

---

## Task 5: password-routes 后端路由(TDD)

**Files:**
- Create: `apps/gateway/src/auth/password-routes.ts`
- Create: `apps/gateway/test/auth/password-routes.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/gateway/test/auth/password-routes.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

import { dao } from '../../src/db/index.js';
import { buildPasswordRoutes } from '../../src/auth/password-routes.js';

const SECRET = 'test-secret-do-not-use-in-prod-1234567';
const COOKIE_NAME = 'lingxi_sid';

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(buildPasswordRoutes({ sessionSecret: SECRET, cookieName: COOKIE_NAME, ttlHours: 24 }));
  return app;
};

describe('password-routes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('POST /api/auth/password/register', () => {
    it('成功注册: 创建用户 + set session cookie + 201 AuthMeResponse', async () => {
      vi.mocked(dao.users.createPasswordUser).mockResolvedValue({ id: 'u_new' });
      vi.mocked(dao.users.getById).mockResolvedValue({
        id: 'u_new', provider: 'password', external_id: 'a@b.com',
        email: 'a@b.com', nickname: 'Qiang', avatar_url: null,
      });

      const res = await request(makeApp())
        .post('/api/auth/password/register')
        .send({ email: 'a@b.com', password: 'secret12', nickname: 'Qiang' });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ user_id: 'u_new', provider: 'password', email: 'a@b.com', nickname: 'Qiang' });
      expect(res.headers['set-cookie']?.some((c: string) => c.startsWith(`${COOKIE_NAME}=`))).toBe(true);
      // 密码应被哈希后传给 dao,而非明文
      const call = vi.mocked(dao.users.createPasswordUser).mock.calls[0]![0];
      expect(call.hash).not.toBe('secret12');
      expect(bcrypt.compareSync('secret12', call.hash)).toBe(true);
    });

    it('邮箱已存在 → 409', async () => {
      vi.mocked(dao.users.createPasswordUser).mockResolvedValue(null);
      const res = await request(makeApp())
        .post('/api/auth/password/register')
        .send({ email: 'a@b.com', password: 'secret12', nickname: 'Qiang' });
      expect(res.status).toBe(409);
    });

    it('密码太短 → 400,不落库', async () => {
      const res = await request(makeApp())
        .post('/api/auth/password/register')
        .send({ email: 'a@b.com', password: 'short', nickname: 'Qiang' });
      expect(res.status).toBe(400);
      expect(dao.users.createPasswordUser).not.toHaveBeenCalled();
    });

    it('邮箱格式非法 → 400', async () => {
      const res = await request(makeApp())
        .post('/api/auth/password/register')
        .send({ email: 'notanemail', password: 'secret12', nickname: 'Qiang' });
      expect(res.status).toBe(400);
    });

    it('称呼为空 → 400', async () => {
      const res = await request(makeApp())
        .post('/api/auth/password/register')
        .send({ email: 'a@b.com', password: 'secret12', nickname: '   ' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/auth/password/login', () => {
    it('成功登录: 校验 hash + set cookie + 200 AuthMeResponse', async () => {
      const hash = bcrypt.hashSync('secret12', 10);
      vi.mocked(dao.users.getPasswordUserByEmail).mockResolvedValue({
        id: 'u1', provider: 'password', external_id: 'a@b.com',
        email: 'a@b.com', nickname: 'Qiang', avatar_url: null, password_hash: hash,
      });

      const res = await request(makeApp())
        .post('/api/auth/password/login')
        .send({ email: 'a@b.com', password: 'secret12' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ user_id: 'u1', provider: 'password' });
      expect(res.headers['set-cookie']?.some((c: string) => c.startsWith(`${COOKIE_NAME}=`))).toBe(true);
    });

    it('密码错 → 401', async () => {
      const hash = bcrypt.hashSync('secret12', 10);
      vi.mocked(dao.users.getPasswordUserByEmail).mockResolvedValue({
        id: 'u1', provider: 'password', external_id: 'a@b.com',
        email: 'a@b.com', nickname: 'Qiang', avatar_url: null, password_hash: hash,
      });
      const res = await request(makeApp())
        .post('/api/auth/password/login')
        .send({ email: 'a@b.com', password: 'wrongpass' });
      expect(res.status).toBe(401);
    });

    it('邮箱不存在 → 401(与密码错同文案,防枚举)', async () => {
      vi.mocked(dao.users.getPasswordUserByEmail).mockResolvedValue(null);
      const res = await request(makeApp())
        .post('/api/auth/password/login')
        .send({ email: 'nobody@b.com', password: 'secret12' });
      expect(res.status).toBe(401);
    });
  });
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `pnpm --filter @lingxi/gateway test password-routes`
Expected: FAIL —— `buildPasswordRoutes` 不存在(模块找不到)。

- [ ] **Step 3: 实现 password-routes**

创建 `apps/gateway/src/auth/password-routes.ts`:

```ts
/**
 * 账号密码登录路由(非 OAuth redirect 流程):
 *   POST /api/auth/password/register  { email, password, nickname }
 *   POST /api/auth/password/login     { email, password }
 * 成功后签发与 OAuth 同一套 session cookie。
 */
import { Router, type Request, type Response, type Router as RouterType } from 'express';
import bcrypt from 'bcryptjs';
import { signSession, sessionCookieOpts } from './session.js';
import type { AuthMeResponse } from '@lingxi/shared';
import { dao } from '../db/index.js';

export interface PasswordRoutesOpts {
  sessionSecret: string;
  cookieName: string;
  ttlHours: number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;
const BCRYPT_ROUNDS = 10;

const toMeResponse = (row: {
  id: string; provider: string; external_id: string;
  email: string | null; nickname: string | null; avatar_url: string | null;
}): AuthMeResponse => ({
  user_id: row.id,
  provider: row.provider,
  external_id: row.external_id,
  email: row.email,
  nickname: row.nickname,
  avatar_url: row.avatar_url,
});

const setSessionCookie = (res: Response, opts: PasswordRoutesOpts, userId: string): void => {
  const token = signSession({ user_id: userId }, opts.sessionSecret, opts.ttlHours);
  res.cookie(opts.cookieName, token, sessionCookieOpts(opts.ttlHours));
};

export const buildPasswordRoutes = (opts: PasswordRoutesOpts): RouterType => {
  const r = Router();

  r.post('/api/auth/password/register', async (req: Request, res: Response) => {
    const email = String(req.body?.email ?? '').trim();
    const password = String(req.body?.password ?? '');
    const nickname = String(req.body?.nickname ?? '').trim();

    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid email' });
    if (password.length < MIN_PASSWORD) return res.status(400).json({ error: 'password too short' });
    if (!nickname) return res.status(400).json({ error: 'nickname required' });

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const created = await dao.users.createPasswordUser({ email, nickname, hash });
    if (!created) return res.status(409).json({ error: 'email already registered' });

    const row = await dao.users.getById(created.id);
    if (!row) return res.status(500).json({ error: 'user lookup failed' });

    setSessionCookie(res, opts, created.id);
    res.status(201).json(toMeResponse(row));
  });

  r.post('/api/auth/password/login', async (req: Request, res: Response) => {
    const email = String(req.body?.email ?? '').trim();
    const password = String(req.body?.password ?? '');
    if (!email || !password) return res.status(401).json({ error: 'invalid credentials' });

    const row = await dao.users.getPasswordUserByEmail(email);
    const ok = row?.password_hash ? await bcrypt.compare(password, row.password_hash) : false;
    if (!row || !ok) return res.status(401).json({ error: 'invalid credentials' });

    setSessionCookie(res, opts, row.id);
    res.status(200).json(toMeResponse(row));
  });

  return r;
};
```

> 注:register 成功后用 `getById` 回读拿规范化的 AuthMeResponse(与 session-routes `toMeResponse` 形状一致),mock-dao 的 `getById` 在测试里被显式 mock。

- [ ] **Step 4: 运行测试,确认通过**

Run: `pnpm --filter @lingxi/gateway test password-routes`
Expected: PASS,8 个用例全绿。

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/auth/password-routes.ts apps/gateway/test/auth/password-routes.test.ts
git commit -m "feat(gateway): 账号密码注册/登录路由 + 测试"
```

---

## Task 6: 挂载 password router 到 gateway

**Files:**
- Modify: `apps/gateway/src/index.ts`(import 区 + 约 :127 挂载区)

- [ ] **Step 1: 加 import**

在 `apps/gateway/src/index.ts` 顶部 import 区(`buildOAuthRouter` import 行 :39 之后)加:

```ts
import { buildPasswordRoutes } from './auth/password-routes.js';
```

- [ ] **Step 2: 挂载路由**

在 `app.use(buildSessionRoutes({...}))`(约 :123-127)之后、`buildOAuthRouter` 之前加:

```ts
    // 账号密码登录路由(主要登录方式)
    app.use(buildPasswordRoutes({
      sessionSecret: config.session.secret,
      cookieName: config.session.cookieName,
      ttlHours: config.session.ttlHours,
    }));
```

- [ ] **Step 3: build 验证**

Run: `pnpm --filter @lingxi/gateway build`
Expected: 编译通过。

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/src/index.ts
git commit -m "feat(gateway): 挂载账号密码登录路由"
```

---

## Task 7: 前端 api.ts 加 login / register

**Files:**
- Modify: `apps/web/src/lib/api.ts`(import 区 + `me`/`logout` 附近 :59)

- [ ] **Step 1: 加类型导入**

在 `apps/web/src/lib/api.ts` 顶部从 `@lingxi/shared` 的 import 列表里加两项:

```ts
  PasswordLoginRequest,
  PasswordRegisterRequest,
```

- [ ] **Step 2: 加 login / register**

在 `export const me = ...`(约 :59)之后加:

```ts
export const login = (body: PasswordLoginRequest): Promise<AuthMeResponse> =>
  json('/api/auth/password/login', { method: 'POST', body: JSON.stringify(body) });

export const register = (body: PasswordRegisterRequest): Promise<AuthMeResponse> =>
  json('/api/auth/password/register', { method: 'POST', body: JSON.stringify(body) });
```

> 注:`json` helper 对 401 抛 `AuthError`,故登录失败时调用方需 catch。`json` 对其他非 2xx 抛 `Error('<path> → <status>')`,409 也走这条。

- [ ] **Step 3: 类型检查**

Run: `pnpm --filter @lingxi/web build`
Expected: 编译通过。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/api.ts
git commit -m "feat(web): api 加 login/register 调用"
```

---

## Task 8: 重写 LoginPage(TDD)

**Files:**
- Modify: `apps/web/test/LoginPage.test.tsx`
- Modify: `apps/web/src/auth/LoginPage.tsx`(重写)

注:`apps/web` 的 `pnpm lint` baseline 即红(见 memory),以 **test + build** 为门。

- [ ] **Step 1: 改测试,先加新断言(预期失败)**

替换 `apps/web/test/LoginPage.test.tsx` 全文为:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { LoginPage } from '../src/auth/LoginPage.js';
import { WithStore } from '../src/atom/index.js';
import * as api from '../src/lib/api.js';

const wrap = (ui: ReactNode) => (
  <MemoryRouter><WithStore>{ui}</WithStore></MemoryRouter>
);

describe('LoginPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // authAtom 初始化时会 fetch /api/auth/me → 用 401 让它进 unauthenticated
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 401 }));
  });

  it('默认登录态: 显示邮箱/密码输入 + 登录按钮', async () => {
    render(wrap(<LoginPage />));
    await waitFor(() => {
      expect(screen.getByPlaceholderText('邮箱')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('密码')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '登录' })).toBeInTheDocument();
    });
  });

  it('切到注册态: 多出"称呼"输入,主按钮变"注册并进入"', async () => {
    render(wrap(<LoginPage />));
    await waitFor(() => screen.getByText('注册'));
    fireEvent.click(screen.getByRole('button', { name: '注册' }));
    expect(screen.getByPlaceholderText('你的称呼')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '注册并进入' })).toBeInTheDocument();
  });

  it('提交登录调 api.login', async () => {
    const loginSpy = vi.spyOn(api, 'login').mockResolvedValue({
      user_id: 'u1', provider: 'password', external_id: 'a@b.com',
      email: 'a@b.com', nickname: 'Qiang', avatar_url: null,
    });
    render(wrap(<LoginPage />));
    await waitFor(() => screen.getByPlaceholderText('邮箱'));
    fireEvent.change(screen.getByPlaceholderText('邮箱'), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByPlaceholderText('密码'), { target: { value: 'secret12' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    await waitFor(() => {
      expect(loginSpy).toHaveBeenCalledWith({ email: 'a@b.com', password: 'secret12' });
    });
  });

  it('登录失败显示错误文案', async () => {
    vi.spyOn(api, 'login').mockRejectedValue(new Error('boom'));
    render(wrap(<LoginPage />));
    await waitFor(() => screen.getByPlaceholderText('邮箱'));
    fireEvent.change(screen.getByPlaceholderText('邮箱'), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByPlaceholderText('密码'), { target: { value: 'secret12' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    await waitFor(() => {
      expect(screen.getByText(/邮箱或密码错误|登录失败/)).toBeInTheDocument();
    });
  });

  it('Google 入口仍在(下方),指向 /api/auth/google/start', async () => {
    render(wrap(<LoginPage />));
    await waitFor(() => {
      const link = screen.getByRole('link', { name: /Google/ });
      expect(link.getAttribute('href')).toBe('/api/auth/google/start');
    });
  });
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `pnpm --filter @lingxi/web test LoginPage`
Expected: FAIL —— 找不到"邮箱"输入框 / "登录"按钮(旧页面只有 Google 按钮)。

- [ ] **Step 3: 重写 LoginPage**

替换 `apps/web/src/auth/LoginPage.tsx` 全文为:

```tsx
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Wallpaper } from '../lib/Wallpaper.js';
import { IconSpark } from '../lib/icons.js';
import { authAtom } from '../states/auth.atom.js';
import * as api from '../lib/api.js';

type Mode = 'login' | 'register';

/**
 * 登录页:账号密码为主(登录/注册 tab),Google OAuth 作为下方次要入口。
 * 将来微信登录接通后,排在 Google 下面形成次要入口栈。
 */
export const LoginPage = () => {
  const [state, actions] = authAtom.use();
  const nav = useNavigate();

  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (state.status === 'authenticated') {
    nav('/desktop', { replace: true });
    return null;
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'login') {
        await api.login({ email, password });
      } else {
        await api.register({ email, password, nickname });
      }
      await actions.refresh();
      nav('/desktop', { replace: true });
    } catch {
      setError(mode === 'login' ? '邮箱或密码错误' : '注册失败,请检查邮箱是否已注册');
    } finally {
      setBusy(false);
    }
  };

  const segBtn = (m: Mode, label: string) => (
    <button
      type="button"
      onClick={() => { setMode(m); setError(''); }}
      style={{
        flex: 1, padding: '7px 0', fontSize: 13, fontWeight: 600, cursor: 'pointer',
        border: 'none', borderRadius: 8,
        background: mode === m ? '#fff' : 'transparent',
        color: mode === m ? '#1b1c20' : 'var(--dim, #6b7280)',
        boxShadow: mode === m ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
      }}
    >{label}</button>
  );

  const inputStyle = {
    width: '100%', padding: '10px 12px', fontSize: 14,
    border: '1px solid var(--border)', borderRadius: 10, outline: 'none',
    boxSizing: 'border-box' as const,
  };

  return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
      <Wallpaper />
      <div className="card fade" style={{ width: 380, padding: 28, background: 'rgba(255,255,255,0.86)', backdropFilter: 'blur(30px)', borderRadius: 20, position: 'relative', zIndex: 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 22 }}>
          <span style={{ display: 'inline-flex', width: 42, height: 42, borderRadius: 12, background: '#7c3aed1f', color: '#7c3aed', alignItems: 'center', justifyContent: 'center' }}>
            <IconSpark size={20} />
          </span>
          <div>
            <div style={{ fontSize: 17, fontWeight: 650 }}>灵犀</div>
            <div className="dim" style={{ fontSize: 12 }}>数字员工平台</div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 4, padding: 4, background: 'rgba(0,0,0,0.04)', borderRadius: 10, marginBottom: 16 }}>
          {segBtn('login', '登录')}
          {segBtn('register', '注册')}
        </div>

        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {mode === 'register' && (
            <input
              placeholder="你的称呼" value={nickname}
              onChange={(e) => setNickname(e.target.value)} style={inputStyle}
            />
          )}
          <input
            placeholder="邮箱" type="email" value={email}
            onChange={(e) => setEmail(e.target.value)} style={inputStyle}
          />
          <input
            placeholder="密码" type="password" value={password}
            onChange={(e) => setPassword(e.target.value)} style={inputStyle}
          />
          {error && <div style={{ color: '#dc2626', fontSize: 12.5 }}>{error}</div>}
          <button
            type="submit" disabled={busy}
            style={{
              width: '100%', padding: 11, marginTop: 8, fontSize: 14, fontWeight: 600,
              border: 'none', borderRadius: 10, cursor: busy ? 'default' : 'pointer',
              background: '#7c3aed', color: '#fff', opacity: busy ? 0.6 : 1,
            }}
          >{mode === 'login' ? '登录' : '注册并进入'}</button>
        </form>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '16px 0' }}>
          <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
          <span className="dim" style={{ fontSize: 11 }}>或</span>
          <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
        </div>

        <a
          href="/api/auth/google/start"
          className="btn"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
            width: '100%', padding: 11, fontSize: 14, fontWeight: 600,
            border: '1px solid var(--border)', background: '#fff', color: '#1b1c20',
            borderRadius: 10, textDecoration: 'none',
          }}
        >
          <GoogleIcon /> 使用 Google 登录
        </a>
      </div>
    </div>
  );
};

const GoogleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18">
    <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
    <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
    <path d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332z" fill="#FBBC05"/>
    <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.167 6.656 3.58 9 3.58z" fill="#EA4335"/>
  </svg>
);
```

> 注:`authAtom.use()` 返回 `[state, actions]`(见 `auth.atom.ts` 的 `AuthActions { refresh, logout }`)。若现有代码里 `authAtom.use()` 的解构签名不同,以实际为准调整。

- [ ] **Step 4: 运行测试,确认通过**

Run: `pnpm --filter @lingxi/web test LoginPage`
Expected: PASS,5 个用例全绿。

- [ ] **Step 5: build 验证**

Run: `pnpm --filter @lingxi/web build`
Expected: 编译通过。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/auth/LoginPage.tsx apps/web/test/LoginPage.test.tsx
git commit -m "feat(web): 登录页改账号密码 tab 表单,Google 下移"
```

---

## Task 9: 全量验证 + 手动冒烟

**Files:** 无(仅验证)

- [ ] **Step 1: 全工程测试**

Run: `pnpm -r test`
Expected: gateway + web 测试全绿(其他包不受影响)。

- [ ] **Step 2: 全工程 build**

Run: `pnpm build`
Expected: 全部编译通过。

- [ ] **Step 3: 手动冒烟(本地)**

Run: `pnpm dev`,浏览器开 `http://localhost:3000`:
- 注册 tab:填称呼/邮箱/密码 → "注册并进入" → 跳 `/desktop`。
- 退出 → 登录 tab:同邮箱/密码 → "登录" → 跳 `/desktop`。
- 错误密码 → 显示"邮箱或密码错误"。
- 重复邮箱注册 → 显示注册失败文案。
- 下方"使用 Google 登录"仍可点(跳 Google,沿用旧流程)。

Expected: 以上全部符合。冒烟仅本地手动,不阻塞 commit。

- [ ] **Step 4: 更新 auth-setup 文档**

在 `docs/auth-setup.md` 开头"当前已接入"列表里,把:
```
- **Google OAuth**
```
改为:
```
- **账号密码**(主要方式,邮箱+密码,见 `apps/gateway/src/auth/password-routes.ts`)
- **Google OAuth**(登录页下方次要入口)
```

- [ ] **Step 5: Commit**

```bash
git add docs/auth-setup.md
git commit -m "docs(auth): 记录账号密码登录为主要方式"
```

---

## Self-Review 记录

- **Spec 覆盖**: 架构定位(Task 5/6)、数据模型 password_hash(Task 1)、DAO 两方法(Task 3)、bcryptjs(Task 4)、后端路由+错误处理(Task 5)、契约(Task 2)、前端 api(Task 7)、LoginPage 重写+Google 下移(Task 8)、文档(Task 9)。非目标(邮件验证/忘记密码/限流/账号合并/微信登录)不产出任务,符合 spec。
- **类型一致性**: `createPasswordUser({email,nickname,hash})`、`getPasswordUserByEmail(email)→UserRow & {password_hash}`、`PasswordLoginRequest{email,password}`、`PasswordRegisterRequest{email,password,nickname}` 在 Task 2/3/5/7 间签名一致。`buildPasswordRoutes({sessionSecret,cookieName,ttlHours})` 在 Task 5/6 一致。
- **占位符**: 无 TBD/TODO,所有代码步骤含完整代码与命令。
- **已知风险**: 无登录限流(spec 已标,生产前补);register 回读 `getById`(多一次查询,可接受)。
