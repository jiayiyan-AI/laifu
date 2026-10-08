# 修改密码 + 找回密码 设计

日期：2026-10-08
状态：待 review

## 背景与目标

目前邮箱密码账号（`users.provider='password'`）只有注册 / 登录，没有修改密码，也没有找回密码。2026-10-08 Maggie（jiaqian@pawsiv.cn）忘记密码时，只能人工直接改 prod Supabase 的 `users.password_hash`。

**目标**：用户在网页上自助完成两件事，运维不再需要碰 DB：

1. **修改密码**：已登录状态下，凭旧密码改成新密码。
2. **找回密码**：在登录页填邮箱，收到重置链接，设置新密码。

**成功标准**

- 两条流程端到端可用。桌面端复用网页登录 / 网页 home，不需要另外开发。
- 改密码 / 重置成功后，该用户其他设备上已登录的网页会话失效。
- 找回接口不能被用来探测某个邮箱是否注册过，也不能被拿来刷邮件。

**不在范围内**

- Google OAuth 用户没有密码，不涉及。
- 登录接口限流（现在完全没有，记为已知风险，另开任务）。
- HTML 邮件模板、邮箱验证（注册时验邮箱）。

## 现状要点

- 路由：`apps/gateway/src/auth/password-routes.ts`，提供 `POST /api/auth/password/register|login`。用 bcryptjs，cost 10。邮箱不存在时用 DUMMY_HASH 跑一次比对，抹平时序差。
- 会话：`auth/session.ts`。HS256 JWT，payload 只有 `{user_id}`，TTL 168h，cookie 名 `lingxi_sid`。`auth/middleware.ts` 的 `requireSession` 只验签名，不查库，**无法吊销**。
- `users.token_version` 用在容器 token / 桌面端 device token（`auth/container-token.ts`、`lib/gateway-token.ts`）。bump 它会连带让 hermes 容器鉴权失效，**不能复用**。
- 签发会话的有 3 处：`password-routes.ts`（setSessionCookie）、`oauth-router.ts:162`、`api/session-handoff.ts:98`。
- 发信：`lib/email/` 里的 `EmailProvider` 抽象（fake | resend），只支持纯文本，目前只给 agent 邮箱路由用。prod 配置为 `EMAIL_PROVIDER=resend`、`EMAIL_DOMAIN=mail.laifu.uncagedai.org`。
- 用户可以自选 agent 邮箱前缀（`isValidEmailLocalpart`，`packages/shared/src/assistant.ts:20`），目前没有保留字。prod 已查，`noreply` 等系统前缀无人占用。
- gateway 没有 `trust proxy`，也没有任何限流。
- 前端：`apps/web`，react-router v6。`LoginPage.tsx` 一页里切换登录 / 注册。没有设置页，账号下拉菜单在 `desktop/Menubar.tsx:45-72`。

## 设计

### 1. 数据（一个迁移）

用 `packages/db` 的 drizzle 生成迁移（`db:generate --name password_reset`）：

```sql
ALTER TABLE users ADD COLUMN session_version integer NOT NULL DEFAULT 0;

CREATE TABLE password_reset_tokens (
  token_hash  text PRIMARY KEY,               -- sha256(token) hex，库里不存原文
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_reset_tokens_user_id_idx ON password_reset_tokens(user_id);
```

迁移只加列（带默认值）和建表，对旧版 gateway 代码兼容，可以先迁移再部署。

### 2. 会话吊销（session_version）

- `SessionPayload` 改成 `{ user_id: string; sv?: number }`。没有 `sv` 的老 JWT 按 `sv=0` 处理。上线时没人会被踢下线，只有改过密码的用户的旧会话会失效。
- `requireSession` 改成异步：验签名 → 取 `users.session_version` → 与 `sv ?? 0` 比对，不一致返回 401 `{error:'session revoked'}`。用户不存在也返回 401。
- 进程内缓存 `Map<userId, {sv, at}>`，TTL 30s。改密码 / 重置的代码路径主动调用 `invalidateSessionVersion(userId)`。prod 只有单实例 B1，30s 的窗口只影响其他设备，可以接受。
- 查库失败时（DB 抖动）**放行**并记日志，和现有 container-token 的容错风格一致，避免 DB 抖一下就让全站 401。
- 3 处签发点都改成签入当前的 `session_version`。OAuth / 密码登录本来就会拿到 user row，session-handoff 需要多查一次。
- `oauth-router.ts:76` 读已有 cookie 时只用它来判断"是否已登录"，保持只验签名，不改。

### 3. 接口

都在 `password-routes.ts`，挂在 `/api/auth/password/` 下：

**`POST /change`**（经过 sessionMw）
- body `{ current_password, new_password }`
- 当前用户不是 password 账号 → 400 `not_password_account`
- 新密码不合规 → 400 `password_too_short` / `password_too_long`
- 旧密码错误 → **403** `wrong_password`（不用 401，避免前端当成会话过期跳回登录页）
- 限流超限 → 429 `rate_limited`
- 成功：在一个事务里写入新 hash 并执行 `session_version = session_version + 1`，清缓存，按新 sv 换发当前 cookie，返回 200 `{ok:true}`

**`POST /forgot`**
- body `{ email }`，格式不合法也返回 202，统一响应。
- **永远返回 202 `{ok:true}`**。
- 只有当 `getPasswordUserByEmail` 命中、且未触发限流时，才执行以下步骤：
  1. 把该用户所有 `used_at IS NULL` 的旧 token 标记为已用（作废）；
  2. 生成 `crypto.randomBytes(32).toString('base64url')`，插入它的 sha256，`expires_at = now()+30min`；
  3. **不 await** 调用 system-mailer 发信，失败只 `log.error`。
- 不等发信结果，是为了让响应时间不暴露邮箱是否存在。

**`POST /reset`**
- body `{ token, new_password }`
- 新密码不合规 → 400 `password_too_short` / `password_too_long`
- 原子消费：
  ```sql
  UPDATE password_reset_tokens SET used_at = now()
  WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
  RETURNING user_id
  ```
  没有返回行 → 400 `invalid_or_expired_token`。并发时只有一个请求能拿到这行。
- 写入新 hash，`session_version + 1`，清缓存，返回 200 `{ok:true}`。**不自动登录**，前端跳到 `/login`。

`AuthErrorCode`（shared contracts）新增：`not_password_account`、`wrong_password`、`password_too_long`、`invalid_or_expired_token`、`rate_limited`。

### 4. 密码规则

shared 里加 `validateNewPassword(pw)`：长度 ≥ `MIN_PASSWORD_LENGTH`(8)，且 UTF-8 字节数 ≤ 72（bcrypt 会截断超出部分）。register / change / reset 三处共用，前端也用它做即时提示。

### 5. 限流

新模块 `apps/gateway/src/lib/rate-limit.ts`：进程内固定窗口计数器 `hit(key, limit, windowMs): boolean`，每分钟清理过期 key。单实例部署，不引入 Redis。

| 场景 | key | 限额 | 超限时 |
|---|---|---|---|
| forgot | `forgot:email:<lower email>` | 60s 1 次 + 1h 5 次 | 照样 202，不发信 |
| forgot | `forgot:ip:<ip>` | 1h 20 次 | 照样 202，不发信 |
| change | `change:user:<id>` | 15min 10 次 | 429 |
| reset | `reset:ip:<ip>` | 1h 20 次 | 429 |

IP 取 `req.ip`。gateway 加 `app.set('trust proxy', 1)`（App Service 前有一层 ARR 反代）。要确认这个改动不影响现有代码对 `req.ip` / `req.protocol` 的使用，以及 cookie `secure` 判断。

### 6. 系统邮件

新模块 `apps/gateway/src/lib/email/system-mailer.ts`：

- 复用 `getEmailProvider(config.email)` 构造 provider（index.ts 现有的 provider 是块级局部变量，抽出来共用一个实例）。
- `sendPasswordReset(to, link)`：
  - 发件人：`noreply@${config.email.domain}`，显示名 `灵犀`
  - 主题：`重置你的灵犀密码`
  - 正文（纯文本）：重置链接，链接 30 分钟内有效且只能用一次，"如果不是你本人操作，请忽略这封邮件，你的密码不会改变"
- 链接：`${frontendBaseUrl || publicBaseUrl}/reset-password?token=<token>`
- **不新增 env**。
- dev 环境走 fake provider，正文（含链接）打印到日志，用于本地冒烟。

**保留前缀**：`isValidEmailLocalpart` 拒绝 `noreply`、`no-reply`、`postmaster`、`admin`、`support`、`security`、`abuse`。防止用户占用系统发件前缀，收到别人的退信和回复。

### 7. 前端（apps/web）

- `/api/auth/me` 已返回 `provider`（`toMeResponse`），前端直接用，无需改。
- **修改密码**：
  - `Menubar.tsx` 账号下拉菜单里，「退出登录」上方加「修改密码」，仅在 `provider==='password'` 时显示。
  - 打开 `ChangePasswordDialog`：旧密码 / 新密码 / 确认新密码，用 `validateNewPassword` 即时校验。
  - 成功提示"密码已修改，其他设备已退出登录"；403 显示"当前密码不正确"。
- **忘记密码**：
  - `LoginPage` 登录模式下加「忘记密码？」链接，跳到 `/forgot-password`。
  - `ForgotPasswordPage`：填邮箱提交后，统一显示"如果该邮箱已注册，你会收到一封重置邮件，请在 30 分钟内完成"。
- **重置密码**：`/reset-password` 对应 `ResetPasswordPage`
  - 挂载时读出 `token`，并用 `history.replaceState` 把它从地址栏去掉。
  - 新密码 / 确认新密码，成功后 `navigate('/login', {state:{notice:'密码已重置，请登录'}})`。
  - `invalid_or_expired_token` 时显示"链接无效或已过期"和「重新申请」链接。
- 样式沿用 `LoginPage` 现有的视觉风格，不新做设计。
- `api.ts` 新增 `changePassword` / `forgotPassword` / `resetPassword`。

桌面端：登录用的 webview 就是网页 `/login`，home 也是远程网页，两条流程自动生效。用户在桌面端点邮件里的链接，会在系统浏览器里完成重置，然后回桌面端用新密码登录。

## 错误处理汇总

- 所有新接口沿用 `fail(res, status, code, msg)` 风格，async handler 全部 try/catch，未知错误返回 500 `internal`。
- `forgot` 里任何内部错误（DB / 发信）都不影响 202 响应，只记日志。
- 日志事件名：`auth.password.change`、`auth.password.forgot`（只记是否命中账号、是否被限流，**不记 token**）、`auth.password.reset`、`auth.session.revoked`。

## 测试

**gateway 单测**（vitest，沿用现有 password-routes 测试的写法）：
- change：成功；旧密码错误返回 403；OAuth 用户返回 400；改完后旧 cookie 返回 401，新 cookie 返回 200；限流返回 429。
- forgot：邮箱存在 / 不存在 / 格式非法时响应完全一样；命中账号才发信（fake provider 断言）；再次申请会作废旧 token；按邮箱限流后不再发信。
- reset：成功后可以用新密码登录；过期 / 已用 / 不存在返回 400；并发消费同一个 token 只有一个成功；重置后旧会话返回 401。
- requireSession：没有 sv 的老 JWT 通过；sv 不一致返回 401；DB 抛错时放行。
- shared：`validateNewPassword` 边界值（7 / 8 字符，72 / 73 字节，多字节中文）；`isValidEmailLocalpart` 拒绝保留字。

**web**：`pnpm --filter web test` + build（lint 在基线上就是红的，不作为通过标准）。

**冒烟**：本地 `pnpm dev`，走一遍：注册 → 修改密码 → 另一个浏览器的旧会话失效 → 退出 → 忘记密码 → 从 gateway 日志拿链接 → 重置 → 用新密码登录。

## 上线顺序

1. prod Supabase 跑迁移（与旧代码兼容）。
2. `build-deploy.sh` + `az webapp deploy` 部署 gateway + web。
3. 线上验证：用测试账号走一遍找回流程，确认 Resend 从 `noreply@mail.laifu.uncagedai.org` 投递成功、没进垃圾箱。

每一步云上动作执行前都要先取得用户同意。

## 风险

- 登录接口仍然没有限流，可以被暴力猜密码，需要另开任务。
- `requireSession` 改成异步并查库，影响所有带登录态的接口。有 30s 缓存和 DB 故障时放行兜底，单测要覆盖到。
- 重置邮件可能被判为垃圾邮件，取决于 `mail.laifu.uncagedai.org` 在 Resend 的 SPF / DKIM 配置。上线验证时要确认。
