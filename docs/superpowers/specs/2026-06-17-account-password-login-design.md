# 账号密码登录 — 设计 spec

> 日期: 2026-06-17 ｜ 状态: 已设计待实现
> 背景: Google OAuth 测试期只有白名单邮箱能登、配置麻烦,改为以"账号密码"为主登录方式。
> UI 参照 `docs/prototype/agentos-macos.html`(登录/注册 tab + 邮箱/密码表单)。

## 目标

新增邮箱+密码注册/登录,成为登录页的主要方式;现有 Google OAuth 降级为下方次要入口。
精简 MVP:注册即登录,不发验证邮件、不做忘记密码。

## 决策记录(已与用户确认)

1. **OAuth 去留**: 保留 Google,作为登录页表单**下方**的次要按钮(占原型里"微信一键登录"的位置)。
   provider-registry 架构整体保留。将来微信登录接通后,排在 Google 下面形成次要入口栈。
2. **严谨度**: 最精简 MVP —— 邮箱+密码直接注册即登录,bcrypt 哈希。**不**发验证邮件、**不**做忘记密码。
3. **哈希库**: 用 `bcryptjs`(纯 JS),避开 Mac arm64 / ACA amd64 原生编译不兼容问题。

## 架构定位

密码登录**不复用** OAuth router(OAuth 是 redirect 流程,密码是表单 POST),新增一组专用路由。
但**复用** `users` 表、session 签发(`signSession`/`sessionCookieOpts`)、`requireSession` middleware、
`/api/auth/me`、`/api/auth/logout` —— 与现有 provider-registry 并行共存,互不污染。

```
POST /api/auth/password/register  { email, password, nickname }  → 201 + set cookie + AuthMeResponse
POST /api/auth/password/login     { email, password }            → 200 + set cookie + AuthMeResponse
GET  /api/auth/me        (不变,复用)
POST /api/auth/logout    (不变,复用)
GET  /api/auth/google/*  (保留,登录页下方次要入口)
```

## 数据模型

复用 `users` 表,**新增一列**:

```sql
ALTER TABLE users ADD COLUMN password_hash text;  -- nullable; OAuth 用户为 null
```

密码用户行:
- `provider = 'password'`
- `external_id = lower(email)`
- `password_hash = bcrypt(password)`
- `email = 原始邮箱`,`nickname = 用户填的称呼`,`avatar_url = null`

天然复用两个现有约束(`packages/db/drizzle/0000_baseline.sql`):
- `users_provider_external_id_unique` on `(provider, external_id)`
- `users_email_unique` on `lower(email) where email is not null` —— **全局**邮箱唯一

含义: 一个邮箱全局只能有一个账号。Google 用户与密码用户不能撞同一邮箱 →
**MVP 不做账号合并**,撞邮箱时注册返 409,靠库约束兜底。

迁移流程: 改 `packages/db/src/schema.ts`(`users` 加 `password_hash: text('password_hash')`)→
`pnpm --filter @lingxi/db db:generate` 生成新 migration → `db:migrate` 落库。

## 后端组件

### `apps/gateway/src/auth/password-routes.ts`(新)
- `buildPasswordRoutes(opts)` 返回 express Router,opts 同 session 那套(sessionSecret/cookieName/ttlHours)。
- `POST /api/auth/password/register`:
  1. 校验 body: email 格式合法、password 长度 ≥ 8、nickname 非空(trim 后)。
  2. `dao.users.createPasswordUser({ email, nickname, hash })`,hash = `bcrypt.hash(password, 10)`。
  3. 唯一约束冲突(邮箱已存在)→ 409 `{ error: 'email already registered' }`。
  4. 成功 → `signSession({ user_id })` + set cookie + 201 返回 `AuthMeResponse`。
- `POST /api/auth/password/login`:
  1. 校验 body 非空。
  2. `dao.users.getPasswordUserByEmail(lower(email))` 取含 hash 的行。
  3. 行不存在 **或** `bcrypt.compare` 失败 → 统一 401 `{ error: 'invalid credentials' }`(不区分,防枚举)。
  4. 成功 → set cookie + 200 返回 `AuthMeResponse`。
- 错误文案统一、不泄漏账号是否存在。

### `apps/gateway/src/db/users-dao.ts`(改)
- 加 `createPasswordUser({ email, nickname, hash }): Promise<{ id }>` ——
  insert `provider='password', external_id=lower(email), email, nickname, password_hash=hash`。
  唯一约束冲突时**让 DB 错误向上抛**(不在 DAO 吞);路由层用 `onConflictDoNothing` +
  `returning` 判空、或 catch Postgres `23505` 唯一冲突码 → 映射 409。实现时优先用
  `onConflictDoNothing().returning()` 返回空数组判定冲突(避免裸 catch 错杀其他错误)。
- 加 `getPasswordUserByEmail(email): Promise<(UserRow & { password_hash: string | null }) | null>` ——
  按 `provider='password' and external_id=lower(email)` 查,带出 `password_hash` 供校验。
- `UsersDao` 接口同步加这两个方法签名。

### `apps/gateway/src/index.ts`(改)
- 挂载 `buildPasswordRoutes(...)`(与 `buildSessionRoutes` / `buildOAuthRouter` 并列)。

### 依赖
- `apps/gateway` 加 `bcryptjs` + `@types/bcryptjs`(devDep)。

### env
- **无新增 env**。bcrypt 不需要配置。三处同步规则(.env.example / config.ts / main.bicep)本次不触发。

## 前端组件

### `apps/web/src/auth/LoginPage.tsx`(重写)
照原型 `renderAuth()`:
- 顶部 `登录 / 注册` 两段式 tab(seg 切换),复用现有 card / Wallpaper / IconSpark 外壳。
- 表单字段: 注册时多一个"称呼"输入;登录/注册都有 邮箱 + 密码(type=password)。
- 主按钮: 登录态文案"登录" / 注册态"注册并进入",提交调 `api.login` / `api.register`。
- 成功 → `authAtom` 的 `refresh()`(或直接 set authenticated)→ `nav('/desktop')`。
- 失败 → 表单内联错误提示(409/401 文案中文化)。
- **下方次要区**: 现有 Google 按钮(`<a href="/api/auth/google/start">`)移到表单下方。
  这里是次要入口栈,将来微信登录接通后排在 Google 下面。

### `apps/web/src/lib/api.ts`(改)
- 加 `login(body: PasswordLoginRequest): Promise<AuthMeResponse>` → POST `/api/auth/password/login`。
- 加 `register(body: PasswordRegisterRequest): Promise<AuthMeResponse>` → POST `/api/auth/password/register`。

### `packages/shared/src/contracts.ts`(改)
- 加 `PasswordLoginRequest { email: string; password: string }`。
- 加 `PasswordRegisterRequest { email: string; password: string; nickname: string }`。
- 响应复用现有 `AuthMeResponse`。

## 数据流

注册:
```
LoginPage(注册) → api.register → POST /api/auth/password/register
  → 校验 → createPasswordUser(bcrypt hash) → signSession → Set-Cookie → AuthMeResponse
  → 前端 authAtom 置 authenticated → nav /desktop
```
登录:
```
LoginPage(登录) → api.login → POST /api/auth/password/login
  → getPasswordUserByEmail → bcrypt.compare → signSession → Set-Cookie → AuthMeResponse
  → 前端 authAtom 置 authenticated → nav /desktop
```

## 错误处理

| 场景 | HTTP | 文案(对前端) |
|---|---|---|
| 注册邮箱已存在 | 409 | 该邮箱已注册 |
| 注册字段非法(邮箱格式/密码<8/称呼空) | 400 | 对应字段提示 |
| 登录邮箱不存在 或 密码错 | 401 | 邮箱或密码错误(不区分) |
| 服务器错误 | 500 | 稍后重试 |

## 测试

- 后端: password-routes 单测 —— 注册成功 set cookie / 重复邮箱 409 / 登录成功 / 密码错 401 /
  字段校验 400。bcrypt compare 路径覆盖。
- DAO: createPasswordUser 唯一冲突、getPasswordUserByEmail 命中/未命中。
- 前端: LoginPage 测试 —— tab 切换、注册/登录提交调对应 api、错误文案渲染、成功跳转。
  (注: `apps/web` 的 `pnpm lint` baseline 即红,以 test + build 为门,见 memory web-lint-baseline-broken。)

## 非目标(MVP 不做)

- 邮件验证 / 注册确认邮件。
- 忘记密码 / 重置密码流程。
- 登录限流 / 防暴力破解 —— **标为已知风险**,生产前需补(如 IP/邮箱维度限流)。
- 账号合并(同邮箱的 Google 账号与密码账号互通)。
- **微信一键登录**: iLink 仅支持"绑定已登录用户",无"用微信登录"能力,本次不做。
  原型下方微信按钮位由 Google 占据。

## 影响面清单

- `packages/db/src/schema.ts` + 新 migration(password_hash 列)
- `apps/gateway/src/db/users-dao.ts`(2 个新方法)
- `apps/gateway/src/auth/password-routes.ts`(新)
- `apps/gateway/src/index.ts`(挂载)
- `apps/gateway/package.json`(bcryptjs)
- `packages/shared/src/contracts.ts`(2 个 request 类型)
- `apps/web/src/lib/api.ts`(login/register)
- `apps/web/src/auth/LoginPage.tsx`(重写)
