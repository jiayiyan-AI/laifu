# Auth Setup

灵犀的认证系统:**provider registry 模式**。一个动态路由 `/api/auth/:provider/{start,callback}` 跑所有 OAuth 平台。加新 provider 只要在 `apps/gateway/src/auth/providers/` 加一个文件 + 在 `index.ts` registry 注册一行,不动路由。

当前已接入:
- **Google OAuth**

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
   - **Authorized redirect URIs**:`http://localhost:9000/api/auth/google/callback` (后端回调,注意是 :9000)
6. 创建后拿:
   - `Client ID` 形如 `xxx.apps.googleusercontent.com`
   - `Client Secret` 形如 `GOCSPX-xxx`

⚠️ 改完 redirect URI **要等 5-10 分钟生效**,否则会拿到 `redirect_uri_mismatch`。

### 2. 填到 gateway

复制 `apps/gateway/.env.example` 到 `apps/gateway/.env.local`(后者 gitignored),填:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
PUBLIC_BASE_URL=http://localhost:9000
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
- Authorized redirect URIs 加:`https://<your-gateway-domain>/api/auth/google/callback`
- 部署时设 `PUBLIC_BASE_URL=https://<your-gateway-domain>`

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
| Web (前端) | 3000 | http://localhost:3000 |
| Gateway (后端) | 9000 | http://localhost:9000 |
| Hermes 容器 | 8080 | 本地共享 |

回调 URL 永远是 **gateway 端口**(9000),不是前端端口(3000)。
