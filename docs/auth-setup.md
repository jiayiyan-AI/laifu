# Auth Setup

灵犀的认证系统两条腿:

1. **账号密码**(主要方式):邮箱 + 密码注册/登录,专用路由 `/api/auth/password/{register,login}`(`apps/gateway/src/auth/password-routes.ts`)。密码 bcrypt 哈希存 `users.password_hash`,`provider='password'` / `external_id=lower(email)`。
2. **OAuth provider registry**(次要方式):一个动态路由 `/api/auth/:provider/{start,callback}` 跑所有 OAuth 平台。加新 provider 只要在 `apps/gateway/src/auth/providers/` 加一个文件 + 在 `index.ts` registry 注册一行,不动路由。

两条腿都签发**同一套 session cookie**(JWT,`apps/gateway/src/auth/session.ts`),`/api/auth/me` 与 `/api/auth/logout` 共用。

当前已接入:
- **账号密码**(登录页主入口:登录/注册 tab 表单)
- **Google OAuth**(登录页下方次要入口)

> MVP 未做:邮件验证、忘记/重置密码、登录限流、同邮箱账号合并(Google↔密码)。详见
> `docs/superpowers/specs/2026-06-17-account-password-login-design.md`。

---

## Google OAuth 配置

### 1. Google Cloud Console 创建凭据

1. 去 https://console.cloud.google.com,选/建 Project
2. 顶部「APIs & Services」→「Credentials」
3. 「Create Credentials」→「OAuth client ID」
4. 第一次会要求先配「OAuth consent screen」:
   - User Type:**External**
   - App name:灵犀(或任意)
   - User support email + Developer contact:你的 Gmail
   - Scopes:`openid`、`email`、`profile`(三个都加)
   - Test users:加你的 Gmail —— **测试阶段只有这些邮箱能登**
5. 回到「Credentials」→「Create Credentials」→「OAuth client ID」:
   - Application type:**Web application**
   - **Authorized JavaScript origins**:`http://localhost:3000` (前端 origin)
   - **Authorized redirect URIs**:`http://localhost:9000/api/auth/google/callback`
     (canonical 模式: redirect 直接指 gateway 端口。gateway 处理完发绝对
     URL 302 跳回前端 :3000/desktop)
6. 创建后拿:
   - `Client ID` 形如 `xxx.apps.googleusercontent.com`
   - `Client Secret` 形如 `GOCSPX-xxx`

⚠️ 改完 redirect URI **要等 5-10 分钟生效**,否则会拿到 `redirect_uri_mismatch`。

### 2. 填到 gateway

复制 `apps/gateway/.env.example` 到 `apps/gateway/.env.local`(后者 gitignored),填:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
PUBLIC_BASE_URL=http://localhost:9000   # gateway 自己的入口,Google callback 命中这里
FRONTEND_BASE_URL=http://localhost:3000 # gateway 处理完跳回这里
```

### 3. 用

重启 `pnpm dev`,浏览器进 http://localhost:3000:
- 主按钮「使用 Google 登录」点了跳 Google 同意页
- 用 test user 邮箱授权
- 回跳到 http://localhost:3000/desktop
- `/api/auth/me` 返回 `{ provider:'google', external_id:<sub>, email, nickname, avatar_url }`

### 部署到云上

把生产域名加到 Console 同一个 OAuth Client(也可建新的):

- Authorized JavaScript origins 加:`https://<your-domain>`
- Authorized redirect URIs 加:`https://<your-domain>/api/auth/google/callback`
  (生产环境前端和 gateway 通常在同一域名下,通过反向代理把 /api/* 转给 gateway)
- 部署时设 `PUBLIC_BASE_URL=https://<your-domain>` (跟 FRONTEND_BASE_URL 同域)

---

## 加新 OAuth provider(GitHub / Apple / 微信开放平台 等)

1. 在 `apps/gateway/src/auth/providers/` 新建 `<name>.ts`,实现 `OAuthProvider` 接口的三个方法:
   - `buildAuthUrl(state, redirectUri): string`
   - `exchangeCode(code, redirectUri): Promise<{access_token}>`
   - `fetchUserinfo(accessToken): Promise<NormalizedUser>`
2. 在 `apps/gateway/src/auth/providers/index.ts` registry 加一行 `if (clientId) providers.<name> = make<Name>Provider(...)`
3. 在 `apps/gateway/src/config.ts` 的 `auth.providers` 加对应 env 字段
4. 在 `apps/gateway/.env.example` 加 env 占位 + 申请凭据链接
5. 在 `apps/web/src/auth/LoginPage.tsx` 加一个 `<a href="/api/auth/<name>/start">` 按钮

路由代码、CSRF state 处理、upsert、session cookie 都共用现有 `oauth-router.ts`,**不用改**。

---

## 端口速查

| 服务 | 默认端口 | 备注 |
|---|---|---|
| Web (前端 + Vite 代理) | 3000 | http://localhost:3000 (用户日常入口) |
| Gateway (后端) | 9000 | OAuth callback 直接命中这里 (canonical 模式) |
| Hermes 容器 | 8080 | 本地共享 |

OAuth callback URL 注册成 gateway 端口 `:9000`,gateway 拿到 code 后:
1. 用 client_secret 换 token (server-to-server)
2. 用 token 拿 userinfo
3. set session cookie + 绝对 URL 302 跳回前端 `http://localhost:3000/desktop`

localhost 下 cookie 不跨端口隔离(同 host),所以 :9000 set 的 cookie 在 :3000
fetch 时浏览器会带上,前后端协作无碍。

---

## 微信扫码绑定 (Phase 1.4 B)

灵犀通过 **iLink** (Tencent 官方 AI bot 框架,`ilinkai.weixin.qq.com`)
绑用户的个人微信号。绑定后:

- 联系人发给用户的消息被助理代收 → Agent 处理 → 自动回复
- 回复用用户的微信号发出,联系人无感

**对用户没有任何申请门槛**: 不需要公众号,不需要厂商 API key,不需要 ngrok,
也不要 webhook 公网暴露。iLink 的 QR 登录是开放的,任何微信号都能扫码绑。

### 用户视角

1. 登入灵犀 → 桌面 → 助理状态卡片右上「绑定微信」按钮 → 弹出 WechatApp 窗口
2. 点「扫码绑定」,窗口里出现 iLink 二维码
3. 用要绑的微信号扫这张二维码 (微信里会弹 iLink 的确认页)
4. 在微信里点「确认」
5. 窗口自动切「✓ 已绑定」,显示 bot ID 末 4 位 + 绑定时间
6. 之后所有联系人发来的 text 消息自动走 Agent

### 解绑

WechatApp 的 bound 视图点「解绑微信」:
- 后端立刻 `pollMgr.stopOne(binding.id)` 停轮询
- DB `wechat_bindings.is_active=false` (软删,保留 ilink_bot_id 历史)
- iLink 那边不动 — 我们没法替用户解除 iLink 跟微信的关联,那是用户在微信里
  自己撤销的事情(在微信里删 iLink 登录设备)

### 重启 gateway 的恢复语义

PollManager 启动时 `startAll()` 扫 DB 拉所有 `is_active=true` 绑定,逐个起
循环。所以 gateway 重启不丢绑定,几秒内恢复轮询。`updates_cursor` 也写在 DB,
不会重放历史消息。

### 失败模式

| 触发条件 | 处理 |
|---|---|
| `bot_token` 失效 (用户在微信里踢了 iLink) | iLink 返 errcode=-14 → PollManager `deactivate` + 自移除。用户在 WechatApp 看到「未绑定」,需重扫。 |
| iLink 网络不通 | pollLoop 指数退避 max 30s 重试,网络回来自动恢复。 |
| 容器没 ready | handleInbound 给发送方发兜底文案「助理还在初始化,请稍后再试」。不写消息,不杀循环。 |
| Agent 报错 | 同上,fallback「处理失败,请稍后再试」。 |

### 已知限制 (MVP)

- 仅 text 消息 (图片/语音/文件/视频暂不支持,silently skip)
- 一个灵犀用户最多绑一个微信号
- 一个微信号同时只能被一个灵犀用户绑 (iLink 扫码确认流程保证,DB 也有 UNIQUE
  防御)
- 1 用户 = 1 thread (所有联系人发来的消息混在同一 hermes 上下文)。后续会
  改成 per-contact thread,但 MVP 先这么走

### 不需要配什么 env

iLink 不需要任何凭证,也不用填 `WECHAT_*` 环境变量。`apps/gateway/.env.example`
里没有也是对的。
