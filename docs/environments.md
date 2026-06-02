# 环境差异 — dev vs prod

## 核心原则

**同一份代码，靠 env 值切行为，不靠 `if (NODE_ENV === 'production')`**。

代码层面看不出 dev/prod 区别；差异全部在 env 值上。这样可以：

- 想验证 prod 行为 → 本地灌 prod env 就能跑
- 想灰度某个 prod 特性 → 改 env，不改代码
- 测试代码不需要 mock 环境分支

`apps/gateway/src/config.ts` 当前 100% 符合，保持。

---

## 全景对照

| 维度 | dev (本地) | prod (Azure) | 谁切 |
|---|---|---|---|
| Provisioner | `local` — 共享单个 docker | `azure` — 每用户独立 ACA | `PROVISIONER` env |
| Hermes 实例 | `scripts/dev-hermes.sh` 起 docker | gateway 运行时 SDK 创建 | provisioner 分支 |
| 前端访问 API | Vite proxy :3000 → :9000 | 同进程同域 `express.static` | dev 走 vite, prod 走 dist |
| Supabase | 本地 `supabase start` 或 cloud dev project | cloud prod project | `SUPABASE_URL`/`KEY` env |
| OAuth redirect | `:9000/api/auth/google/callback` | `https://<host>/api/auth/google/callback` | `PUBLIC_BASE_URL` + Google Console |
| Secret 来源 | `apps/gateway/.env.local` 手填 | KV → App Service appSettings 注入 | bicep KV reference |
| 前后端域 | 跨端口 (9000 / 3000) | 同域 | `FRONTEND_BASE_URL` env |

---

## 三守则

### 1. 不要写 NODE_ENV 分支

差异性的行为，让它体现为 **env 值不同**，不是 **代码分支不同**。

```ts
// ❌
const url = NODE_ENV === 'production' ? 'https://api' : 'http://localhost'

// ✅
const url = process.env.API_URL
```

唯一例外：`apps/gateway/src/index.ts` 启动时检测 `web/dist` 存在性、`config.ts` 启动期校验必填 env — 这是入口侧的条件加载，不是业务逻辑分支。

### 2. env 名字单一来源 — `.env.example` 是真相

任何新加的 env，**必须同步出现在三个地方**：

1. `apps/gateway/.env.example` — 真相源 + 注释
2. `apps/gateway/src/config.ts` — 读取并暴露给业务
3. `infra/bicep/main.bicep` `appSettings` — 生产灌入 (敏感值走 KV)

漏一处，两环境就开始漂移。

### 3. dev 用真凭据走 cloud 服务

凡是有 cloud 版的服务，能走 cloud dev project 就别本地模拟：

- ✅ Google OAuth — 一对 client_id 加多个 redirect URI 即可
- ✅ Supabase Cloud — 起独立 dev project，多人共享
- ✅ Anthropic / DashScope — dev/prod 用各自 key
- ⚠️ Hermes — **例外**，每用户起 ACA 太慢/太贵，dev 必须走本地 docker

---

## 本地开发起步

```bash
cp apps/gateway/.env.example apps/gateway/.env.local
# 编辑 .env.local 按文件内注释填值

# Supabase 选择一种:
#   (A) 本地: cd infra && supabase start
#   (B) cloud: 把 dev project URL/KEY 填到 .env.local

cp docker/hermes/.env.example docker/hermes/.env
# 填 ANTHROPIC_API_KEY 或 DASHSCOPE_API_KEY

# Hermes 镜像 build (首次, ~10 分钟)
docker build -t hermes-probe docker/hermes/

pnpm install
pnpm dev:check    # 自检 prereq
pnpm dev          # 同时起 hermes + gateway + web (concurrently)
```

打开 `http://localhost:3000` 验证：登录 → 创建数字员工 → 聊天。

---

## Provisioning — 两环境的核心差异

「给用户开通一个 Hermes 实例」这件事，dev 和 prod 走两条**完全不同的代码路径**，但对上层业务代码透明。这是整个项目里**唯一一处**两环境实现不同的地方，理解它就理解了整个分层。

### 代码结构

```
apps/gateway/src/provisioning/
├── manager.ts    生产真流程: 调 azure.ts 创建 ACA + File Share + binding
├── azure.ts      Azure SDK 封装 (createFileShare / createContainerApp / ...)
├── local.ts      本地假流程: 不创建任何东西, 只走 fake 进度条
└── recovery.ts   启动时清理上次 stuck 在 'provisioning' 状态的行
```

入口在 `index.ts`，按 `PROVISIONER` env dispatch：

```ts
const defaultProvisioner = async (args) => {
  if (config.provisioner === 'local') {
    await provisionContainerLocal({ ..., localContainerUrl });
  } else {
    await provisionContainer({ ..., azure: azureModule });   // → manager.ts
  }
};
```

### dev (`PROVISIONER=local`) 在做什么

`local.ts` **不创建任何容器**，只做三件事：

1. 走 6 步假进度 (`'正在生成数字助理实例'` → 100%)，每步往 supabase `container_mapping` 写 `provisioning_step` + `progress_pct`，让前端 `/api/status` 能看到进度条
2. 最后把 `container_url` 设成 **固定值 `LOCAL_CONTAINER_URL=http://localhost:8080`**
3. 状态置 `ready`

**前提**：`pnpm dev` 同时通过 `scripts/dev-hermes.sh` 起了 docker 监听 `:8080`。**所有 dev 用户共用这一个容器**。

### prod (`PROVISIONER=azure`) 在做什么

`azure.ts` 用 Azure SDK 真做三步 (实测 22s)：

1. `storageClient.fileShares.create` — 在 Storage Account 建 `user-<userId>` file share
2. `appClient.managedEnvironmentsStorages.createOrUpdate` — 把 share 注册成 ACA Env 的 storage binding
3. `appClient.containerApps.beginCreateOrUpdateAndWait` — 拉 ACR 的 hermes 镜像启动 Container App，挂 volume + 注入 LLM secret

最后取 `properties.configuration.ingress.fqdn` 作为 `container_url` 写回 supabase。每用户拿到自己独立的 `https://hermes-<userId>.xxx.azurecontainerapps.io`。

### 业务代码不关心环境

chat / status 路由不分支：

```ts
const mapping = cache.get(userId);              // 从 supabase 查
const res = await fetch(`${mapping.container_url}/chat`, { ... });
```

- dev: 所有人的 `container_url` 都是 `http://localhost:8080`，fetch 打到本地 docker
- prod: 每人是自己的 ACA FQDN

**业务层完全感知不到** dev 是共享容器、prod 是独立容器。这是设计得最干净的地方。

### 对照表

| 维度 | dev (local) | prod (azure) |
|---|---|---|
| 触发开通时做什么 | 写假进度到 DB | 真调 Azure SDK 起 ACA + File Share |
| 实测耗时 | ~4s (`stepDelayMs * 5`) | ~22s |
| 用户间隔离 | ❌ 共享 docker + volume | ✅ 独立 ACA + 独立 File Share |
| `container_url` | 固定 `LOCAL_CONTAINER_URL` | 每用户独立 FQDN |
| LLM key 怎么进容器 | `docker run --env-file docker/hermes/.env` (启动时) | secret 注入到每个 ACA 的 env |
| 多用户测试 | 数据会串，dev 只测单账号 | 真隔离 |

### 几个常见问题

**Q: dev 想验证「创建中」UI 怎么办？**
A: `local.ts` 已经用 `stepDelayMs=800` × 5 步 ≈ 4 秒走假进度条，前端能看到状态机变化。

**Q: dev 想接真 Azure 调试某个 bug？**
A: 改 `.env.local` 把 `PROVISIONER=azure` + 填 `AZURE_*` 凭据。可行但很少这么做（贵 + 慢 + 残留资源要清理）。

**Q: 写测试时怎么避开真创建？**
A: `createApp({ provisioner: myFakeFn })` — entry 允许注入自定义 `ProvisionerFn`，所有测试用 `vi.fn()` 替换。

**Q: 为什么不能让 dev 也走 `azure.ts` 用本地 docker 的 Container App emulator？**
A: ACA 没有官方 local emulator，社区方案不靠谱。共享 docker 的简陋方案对 dev 已经够用 — dev 只需要验证「跟一个 hermes 进程通信能成功」，不需要验证 Azure SDK 调用本身（那是部署阶段的事）。

---

## Supabase 双模式怎么选

| 场景 | 推荐 |
|---|---|
| 大多数本机开发 | 本地 `supabase start` (54321)，离线友好 |
| 想用手机/平板访问 dev 实例 | Supabase Cloud dev project (浏览器/移动端都能连) |
| 多人协作要共享数据 | Cloud dev project |
| 想模拟接近生产的网络延迟 | Cloud dev project |

切换很容易：换 `.env.local` 里的 `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` 两行，重启 gateway。

---

## 生产部署 (Azure)

env 来源在 Azure 上是分层的：

```
┌─ 非敏感 env (bicep appSettings 直接写) ───────────────┐
│  PUBLIC_BASE_URL, FRONTEND_BASE_URL, PORT,           │
│  PROVISIONER=azure, AZURE_*, HERMES_*                │
├─ 敏感 env (KV secret + bicep @Microsoft.KeyVault) ──┤
│  SESSION_SECRET, SUPABASE_*, GOOGLE_*,               │
│  ANTHROPIC_API_KEY, DASHSCOPE_API_KEY                │
└──────────────────────────────────────────────────────┘
                       ↓
            App Service process.env
                       ↓
              gateway src/config.ts
```

部署流程 `infra/README.md`。

---

## 加新 env 的标准动作

每次加一个新 env，按这个顺序：

1. **决定它是不是敏感** — 落地为 KV (敏感) 还是 plain appSetting
2. **加到 `apps/gateway/.env.example`** — 注释里写 dev/prod 各填什么
3. **加到 `apps/gateway/src/config.ts`** — 用 `process.env['XXX'] ?? '默认'` 读
4. **加到 `infra/bicep/main.bicep` appSettings**:
   - 非敏感：直接 `XXX: 'value'` 或引用其他资源属性
   - 敏感：`XXX: '@Microsoft.KeyVault(VaultName=${kv.name};SecretName=xxx)'` + 手动 `az keyvault secret set`
5. **如果是必填**：加到 `config.ts` 的 `validateConfig()` 里的 `required(...)` 校验

漏一步，两环境一定会漂移。

---

## OAuth 跨环境的具体配置

Google OAuth Console 一对 client_id 可以挂多个 redirect URI。建议：

| 用途 | Authorized JavaScript origin | Authorized redirect URI |
|---|---|---|
| dev | `http://localhost:3000` | `http://localhost:9000/api/auth/google/callback` |
| prod | `https://<host>.azurewebsites.net` | `https://<host>.azurewebsites.net/api/auth/google/callback` |

**两套都加，不要替换**。代码里靠 `PUBLIC_BASE_URL` 决定生成哪个 redirect_uri，Google 校验时只要在白名单里就过。

如果有合规要求要 dev/prod client 隔离，就建两对 client_id 分别填到两环境的 env，配置方式相同。

---

## 反模式 (踩了请回头看本文档)

- ❌ 用 `NODE_ENV === 'production'` 分支业务逻辑
- ❌ 把 prod secret 提交进 `.env.production` (有 `.env.local` 就够了)
- ❌ 给 dev mock 一个假 Google OAuth (维护成本高于真用)
- ❌ 在 bicep 里 hardcode 一份 env, 在 `.env.example` 里另写一份 — 名字必同步
- ❌ dev 用本地 supabase, prod 用 cloud, 然后某个 SQL 只在本地建过 (用 migration 文件 / supabase db push)
