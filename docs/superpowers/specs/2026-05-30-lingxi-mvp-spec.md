# 灵犀 MVP 实施 Spec

> 本文档是灵犀 MVP 的实施规格说明。配套的高阶架构文档：
> [`architecture-overview.md`](architecture-overview.md)。本 Spec 在调度层、产品形态、数据模型上对架构总览做具体收窄。**冲突时以本文档为准。**

---

## 0. 文档状态

- 起草日期：2026-05-30
- 调度层：**方案 A — Container App + 同步 HTTP/SSE**（架构总览第五章未决项已敲定）
- 范围：MVP 端到端骨架（注册 → 购买 → 绑微信 → 聊天）
- Hermes Docker Image 和 Container HTTP server：**由同事负责（待补）**——本文档只约定其对外 HTTP 契约

---

## 1. 产品定位

**灵犀（LingXi）** — 数字员工平台。用户注册账号后购买一个专属的"灵犀助理"，可通过 Web 端或绑定微信后在微信对话框中调用。

底层每用户一个独立的 Hermes Agent Container，靠 Docker + Azure Container Apps 做多租户隔离。

### 1.1 用户旅程

```
[注册]   微信开放平台 OAuth 登录（自实现）
            │
            ▼
[主页]   显示 onboarding：未激活 → "购买并激活灵犀助理"
            │
            ▼
[购买]   单按钮触发（MVP 免费，无套餐选择）
            │
            ▼
[Provisioning]   6 步进度页（约 1-3 分钟，UI 卡住等待）
            │   • 创建账户与订单
            │   • 生成数字助理实例（Azure Container App）
            │   • 分配 DID 与 Agent 运行时（Azure Files）
            │   • 初始化默认能力（联网搜索 / 文件读写 / 微信收发）
            │   • 装载基础知识库
            │   • 灵犀助理上岗完成
            ▼
[激活完成]   进入主界面（macOS 桌面隐喻）
            │
            ▼
[使用]   三个 Dock app：
            • 灵犀助理（聊天，多 thread）
            • 我的助理（已装备能力概览；无市场入口）
            • 微信绑定（扫码绑定）
```

### 1.2 Phase 1 明确不做

- 多人扫码 — 一个 bot 只能绑定购买者本人的微信，无 `contact_id` 隔离
- 危险工具 approval 拦截 — 全自动批准
- 能力市场 / 专家市场 — UI 完全隐藏，后端默认开所有工具
- 套餐计费 — UI 不显示套餐，购买流程即激活，不调支付
- 消息附件 — 仅纯文字（图片/语音/文件等下个迭代）

---

## 2. 整体架构

```
                ┌──────────────┐         ┌──────────────┐
                │  微信(iLink) │         │  浏览器(Web) │
                └──────┬───────┘         └──────┬───────┘
                       │ HTTPS                  │ HTTPS
                       │                        │
                       └────────────┬───────────┘
                                    ▼
                  ┌────────────────────────────────────┐
                  │  App Service B1 (Node.js 24)       │
                  │  ┌──────────────────────────────┐  │
                  │  │ Web API: auth/purchase/chat  │  │
                  │  │ iLink 长轮询管理器             │  │
                  │  │ Provisioning 异步任务管理     │  │
                  │  │ container_mapping 内存缓存    │  │
                  │  └──────────────────────────────┘  │
                  └─────────┬──────────────────────────┘
                            │ 内网 HTTPS（VNet 内）
                            ▼
                  ┌────────────────────────────────────┐
                  │  Azure Container Apps Environment   │
                  │  （internal ingress, VNet 内可见）   │
                  │  ┌──────────┐ ┌──────────┐ ┌──┐   │
                  │  │ user-a   │ │ user-b   │ │..│   │
                  │  │ 🟢 ready │ │ 💤 sleep │ │  │   │
                  │  └─────┬────┘ └─────┬────┘ └──┘   │
                  └────────┼────────────┼─────────────┘
                           │            │
                           ▼            ▼
                  ┌────────────────────────────────────┐
                  │  Azure Files                        │
                  │  user-a/home/  user-b/home/  ...    │
                  │  （挂载到容器的 /home/hermes）       │
                  └────────────────────────────────────┘
                                    
                  ┌────────────────────────────────────┐
                  │  Supabase Free (US 机房)            │
                  │  PostgreSQL: users / wechat_sessions│
                  │  / context_tokens / container_mapping│
                  │  / threads                          │
                  └────────────────────────────────────┘
```

### 2.1 技术栈速查

| 层 | 选型 | 备注 |
|---|---|---|
| 前端 | React + Vite | macOS 桌面隐喻参考 prototype/agentos-macos.html |
| Gateway | Node.js 24 + Express/Fastify | App Service B1（待选具体框架）|
| Auth | 微信开放平台 OAuth（自实现） | ~100 行代码 |
| 数据库 | Supabase Free（US 机房）| Gateway 内存缓存抵消跨太平洋延迟 |
| Container HTTP server | Python + FastAPI/Starlette | 库模式 import hermes_cli |
| Image base | python:3.12-slim | 沿用 hermes-webui 约定 |
| Image Registry | Azure Container Registry | 手动 build 和 push |
| 计算 | Azure Container Apps | 缩容到 0 |
| 存储 | Azure Files | 每用户一个 share，挂 /home/hermes |
| 部署 | Azure（App Service + ACA + ACR + AF）+ Supabase | 全 Azure + 外部 Supabase |

### 2.2 Repo 结构（Monorepo）

工具栈：**pnpm workspaces**（不引入 Turborepo / Nx）。Container 的 Python 项目也纳入同一个 repo。Azure IaC 在顶级 `infra/` 目录独立维护。

```
laifu/                                # repo 根
├── apps/
│   ├── gateway/                      # Node.js Gateway（§5）
│   ├── web/                          # React + Vite 前端（§9）
│   └── container/                    # Python Container HTTP server + Hermes Image（§4，同事负责）
├── packages/
│   └── shared/                       # Gateway 和 Web 共用 TS 类型
│       ├── src/
│       │   ├── types.ts              # User / ContainerMapping / Thread / WechatSession ...
│       │   └── contracts.ts          # POST /chat/start 请求响应 / SSE 事件 schema
│       ├── package.json
│       └── tsconfig.json
├── infra/                            # Bicep 模板（Phase 2 补，MVP 阶段可手动建）
├── docs/                             # 已存在的文档目录
├── package.json                      # 根 workspace 定义
├── pnpm-workspace.yaml
├── tsconfig.base.json                # 共享 TS 配置
├── .gitignore
└── README.md
```

**关键约定**：

- `pnpm-workspace.yaml` 包含 `apps/*` 和 `packages/*`；Python 项目 `apps/container/` 在 pnpm 视角下不存在，独立用 `pyproject.toml` + venv 管理
- `packages/shared` 是跨语言 contract 的 **TS 单一来源**：DB row 类型、API 请求响应、SSE 事件 schema 全部从这里 import。Gateway 和 Web 直接消费；Python 侧由同事手动对齐（或后续上 OpenAPI 生成器自动同步）
- `infra/` 放整套 Bicep 模板用于一键 stand up dev/staging/prod；MVP 起步可纯手动配资源，模板留到 Phase 2 补
- 每个 `apps/*` 独立可 build / 独立 Dockerfile / 独立部署目标

---

## 3. 调度层方案 A：Container HTTP 契约

Gateway 通过双点 HTTP 接口调用 Container 内的 HTTP server。**契约是 Gateway 和 Container 之间的硬约定**，Container 实现由同事完成。

### 3.1 接口 1：POST /api/chat/start

**目的**：启动一次 Hermes 处理流程，返回流式凭证。

**请求**：
```http
POST /api/chat/start HTTP/1.1
Content-Type: application/json

{
  "session_id": "web:thr_abc123" | "wechat:main",
  "message": "明天天气怎么样",
  "source": "wechat" | "web"
}
```

**响应**：
```json
HTTP/1.1 200 OK
Content-Type: application/json

{ "stream_id": "stm_xyz789" }
```

错误响应：4xx / 5xx + `{"error": "..."}`

### 3.2 接口 2：GET /api/chat/stream

**目的**：拿 stream_id 订阅 SSE 流。

**请求**：
```http
GET /api/chat/stream?stream_id=stm_xyz789 HTTP/1.1
```

**响应**：SSE 流（Content-Type: text/event-stream），事件类型：

| event | data 形态 | 触发时机 |
|---|---|---|
| `token` | `{"text": "..."}` | LLM 每个 token delta |
| `tool` | `{"name": "...", "preview": "..."}` | 工具调用开始 |
| `done` | `{"full_reply": "...", "session_id": "..."}` | 处理完成，最终回复 |
| `error` | `{"message": "...", "trace": "..."}` | 异常 |
| `: heartbeat` | — | SSE 注释，每 30s 一次保活 |

不实现：`approval` 事件（MVP 全自动批准，不需要交互）

### 3.3 双点设计的原因

为支持中途断线后 Gateway 用同一个 `stream_id` 重新 GET 接上流。Container 侧 stream 状态保留 60 秒（可调），超时后清理。

### 3.4 健康检查

```http
GET /healthz HTTP/1.1

200 OK
{ "ok": true, "uptime_seconds": 12345 }
```

ACA 的 readinessProbe 用这个 endpoint 判断容器是否能接流量。

---

## 4. Container 内部约定

> 实现细节由同事完成，此节是接口约束。

### 4.1 Hermes 集成方式

- 库模式：HTTP server 直接 `import hermes_cli`（不 fork subprocess）
- SSE 事件来源：用 hermes 提供的 callback（参考 hermes-webui 的 `stream_delta_callback` / `tool_progress_callback`）

### 4.2 Session 管理

- session_id 是 Container 内 Hermes 对话历史的 key
- 不同 session_id 完全隔离上下文
- 同一 session_id 并发请求要串行（参考 hermes-webui 的 `SESSION_AGENT_LOCKS`）
- session 历史文件存放路径：`/home/hermes/.hermes/webui/sessions/{session_id}.json`（沿用 hermes-webui 约定）

### 4.3 文件系统

- 挂载点：`/home/hermes`（整个 home 目录挂到 Azure Files volume）
- 包安装目录（env vars）：
  ```
  PIP_USER=1
  PYTHONUSERBASE=/home/hermes/.local
  NPM_CONFIG_PREFIX=/home/hermes/.npm-global
  PATH=/home/hermes/.local/bin:/home/hermes/.npm-global/bin:$PATH
  ```
- 新容器首次启动：从 `/home/hermes-seed` 拷贝默认配置（详见架构总览 §9）

### 4.4 工具策略

- MVP 全自动批准（不拦截任何工具调用）
- 默认启用工具集（参考 hermes-webui 的 `CLI_TOOLSETS`）：浏览器、文件、终端、记忆、搜索等

---

## 5. Gateway 模块和职责

Gateway 是单一 Node.js 进程，对内分四个模块。在 monorepo 里位于 `apps/gateway/`：

```
apps/gateway/
├── src/
│   ├── index.ts                    # 入口
│   ├── config.ts                   # 环境变量
│   ├── db/
│   │   ├── supabase.ts             # Supabase 客户端
│   │   └── cache.ts                # container_mapping 内存缓存
│   ├── api/
│   │   ├── auth.ts                 # 微信 OAuth 登录回调
│   │   ├── purchase.ts             # 购买入口（触发 provisioning）
│   │   ├── status.ts               # 进度查询
│   │   ├── threads.ts              # Web 端 thread CRUD
│   │   ├── chat.ts                 # Web 端聊天（POST start + GET stream，SSE 透传）
│   │   └── wechat.ts               # 扫码绑定流程
│   ├── ilink/
│   │   ├── manager.ts              # iLink 会话管理器（启动/恢复/调度）
│   │   ├── poller.ts               # 单用户 long-polling 循环
│   │   ├── sender.ts               # 发消息 + 限流队列
│   │   └── tokens.ts               # bot_token / context_token 持久化
│   ├── provisioning/
│   │   ├── manager.ts              # 异步 provisioning 调度
│   │   ├── azure.ts                # Azure SDK 包装
│   │   └── recovery.ts             # 启动恢复
│   └── dispatch/
│       └── container.ts            # 把消息转发到对应 Container 的 /chat
├── package.json                     # 依赖 @lingxi/shared
├── tsconfig.json                    # extends ../../tsconfig.base.json
└── Dockerfile                       # 部署用（独立 image）
```

类型从 `@lingxi/shared` import（见 §2.2）；不在 gateway 本地重复定义 DB row / API 请求响应 / SSE 事件等跨包共享类型。

### 5.1 启动序列

```
1. 加载配置 + 连 Supabase
2. 全量加载 container_mapping → 内存缓存
3. 启动 provisioning recovery（扫表 status=provisioning，查 Azure 续追）
4. 启动 iLink session manager（扫表 wechat_sessions status=active，挂 polling）
5. 启动 HTTP server，监听 Web API
6. 注册 SIGTERM handler 做 graceful shutdown
```

### 5.2 关键的状态都是 DB 优先

- `container_mapping` 状态：DB 是 source of truth，内存只是读缓存
- iLink bot_token：DB 持久化
- context_token：DB 覆盖式存储（每对话方一份最新）
- 内存里只放 polling 协程引用、HTTP server 实例

App Service 随时可以重启，从 DB 全量恢复。

---

## 6. 数据库 Schema

部署到 Supabase Free（PostgreSQL 15）。

### 6.1 users

```sql
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wx_unionid    TEXT UNIQUE NOT NULL,         -- 微信开放平台 unionid
  nickname      TEXT,
  avatar_url    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
```

### 6.2 container_mapping

```sql
CREATE TABLE container_mapping (
  user_id              UUID PRIMARY KEY REFERENCES users(id),
  container_name       TEXT NOT NULL UNIQUE,    -- hermes-<userid 短哈希>
  container_url        TEXT,                    -- 就绪后填，e.g. https://...internal.azurecontainerapps.io
  status               TEXT NOT NULL CHECK (status IN ('provisioning','ready','failed')),
  provisioning_step    TEXT,                    -- 6 步进度文案当前在哪一步
  progress_pct         INT DEFAULT 0,           -- 0~100
  error_message        TEXT,
  azure_files_share    TEXT,                    -- Azure Files share 名字
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  ready_at             TIMESTAMPTZ
);
```

### 6.3 wechat_sessions

```sql
CREATE TABLE wechat_sessions (
  user_id      UUID PRIMARY KEY REFERENCES users(id),
  bot_token    TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','disabled')),
  bound_wx_nick TEXT,                            -- 绑定的微信昵称
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
```

### 6.4 context_tokens

```sql
CREATE TABLE context_tokens (
  user_id      UUID NOT NULL REFERENCES users(id),
  contact_id   TEXT NOT NULL,                   -- Phase 1 固定为用户自己的 wx openid
  token        TEXT NOT NULL,
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, contact_id)
);
```

### 6.5 threads（A2 方案新增）

```sql
CREATE TABLE threads (
  id           TEXT PRIMARY KEY,                -- e.g. "thr_abc123"
  user_id      UUID NOT NULL REFERENCES users(id),
  source       TEXT NOT NULL CHECK (source IN ('web','wechat')),
  title        TEXT,                            -- 首条用户消息前 64 字
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  archived     BOOLEAN DEFAULT FALSE
);

CREATE INDEX threads_user_updated ON threads (user_id, updated_at DESC);
```

> 备注：thread 的**消息内容**不存在 Gateway 这里——存在 Container 里的 `/home/hermes/.hermes/webui/sessions/{session_id}.json`。Gateway 的 `threads` 表只存 thread 元数据（标题、时间）用于 sidebar 列表。Web 端进入某个 thread 时通过容器 HTTP 拉历史。
>
> session_id = `${source}:${thread_id}`（web）或 `wechat:main`（微信永远一个）。

---

## 7. Onboarding / Provisioning 状态机

### 7.1 状态流

```
注册                          users.INSERT
  │
  ▼
登录后主页                      显示 onboarding 卡片
  │
  ▼ 点"购买并激活灵犀助理"
购买                          container_mapping.INSERT
  │                            (status='provisioning', step='创建账户与订单')
  ▼ 立刻返回 200，开始异步任务
provisioning                  ① 创建 Azure Files share
  │                            ② Azure.beginCreateOrUpdate ContainerApp
  │                            ③ poll 1-3 min
  │                            （Gateway 的 provisioning 任务每进一步主动 UPDATE
  │                             container_mapping 的 provisioning_step + progress_pct，
  │                             不依赖 Azure 主动通知）
  ▼
  ┌────────────────────────┬─────────────────────┐
  ▼                        ▼                     ▼
ready                    failed              永远卡着
container_mapping        container_mapping   启动恢复扫表续追
SET status='ready',      SET status='failed'
url=fqdn                 error_message=...
ready_at=NOW()
  │                        │
  ▼                        ▼
UI 解锁"绑定微信"       UI 显示"创建失败，重试"
                          (按钮重置 status 为 provisioning 重跑)
```

### 7.2 Phase 1 严格规则

- 购买后 UI **卡进度页**直到 ready / failed，**不允许跳走**
- provisioning 期间用户**无法**进入绑微信流程（按钮 disabled）
- provisioning 期间用户**无法**给 bot 发消息（因为没绑微信，也没有 web chat thread）
- 因此 **不需要 deferred_messages 表**

### 7.3 启动恢复

App Service 启动时：

```
rows = SELECT user_id, container_name FROM container_mapping WHERE status='provisioning'
for each row:
  state = await azure.containerApps.get(row.container_name).provisioningState
  match state:
    'Succeeded'  → UPDATE status='ready', url=fqdn
    'Failed'     → UPDATE status='failed', error_message=...
    'Canceled'   → UPDATE status='failed'
    'InProgress' → 启动新本地 poller 继续追这个 resource
    not found    → 视为初始化失败，UPDATE status='failed'
```

### 7.4 失败处理

- 不自动重试（避免 Azure 资源配额被打满）
- UI 显示重试按钮：用户主动点击 → Gateway 把 `status` 重置为 `provisioning` + 起一个新的 provisioning 任务
- 超时阈值：单次 provisioning > 10 分钟视为卡住，标 failed

---

## 8. 消息流（已绑微信后的稳态）

### 8.1 微信端收消息 → 回复

```
朋友(自己) 发微信 ──> iLink 服务器 ──> Gateway iLink poller
                                          │
                                          ▼
                          UPSERT context_tokens (user_id, contact_id, token)
                                          │
                                          ▼
                          读内存缓存：container_mapping[user_id]
                                          │
                                          ▼
                          POST {container_url}/api/chat/start
                          { session_id: "wechat:main", message, source: "wechat" }
                                          │
                                          ▼
                                  ← { stream_id }
                                          │
                                          ▼
                          GET {container_url}/api/chat/stream?stream_id=X
                                          │
                                          ▼ 累积 token 事件直到 done
                                  ← event: done { full_reply }
                                          │
                                          ▼
                          调 iLink 发回复（带 context_token）
                                          │
                                          ▼
                                  朋友(自己) 在微信看到回复
```

### 8.2 Web 端聊天

浏览器跟 Gateway 之间也走双点（跟 Gateway↔Container 模式一致，并兼容 EventSource API 只能 GET 的限制）。

```
浏览器 ── POST /api/chat/start ──> Gateway
         { thread_id, message }
                                    │
                                    ▼
                          thread_id → session_id (e.g. "web:thr_abc")
                          读内存缓存 container_url
                          POST {container_url}/api/chat/start
                                  → { stream_id_inner }
                          内存里把 stream_id_outer ↔ stream_id_inner 映上
                                    │
       <── { stream_id_outer } ─────│
浏览器                                
       ── GET /api/chat/stream?stream_id=stm_outer ──> Gateway
                                                       │
                                                       ▼
                                            查映射 → stream_id_inner
                                            GET {container_url}/api/chat/stream?stream_id=stm_inner
                                                       │
       <── SSE byte stream ────────────────  pipe 透传（不解析重发）
浏览器
```

Gateway 对 web 端是 **SSE 透传代理**：拿到 Container 的 SSE 字节流，直接 pipe 给浏览器。浏览器看到的事件类型跟 Container 发的一模一样。

> 实现层面：Node 的 `fetch().body.pipe(res)` 或 `for await` 转写。注意要设响应头 `Content-Type: text/event-stream`、`X-Accel-Buffering: no`（关闭反代缓冲）。
>
> 为什么 Gateway 要做内外两个 stream_id 的映射：不直接把 Container 的 stream_id 暴露给浏览器，避免泄露内部结构 + 留出未来 Gateway 做断线重连补偿的空间。

### 8.3 Web 端 thread 管理

| Web 端动作 | Gateway 接口 | Gateway 动作 |
|---|---|---|
| 进入聊天页 | GET /api/threads | 返回 thread 列表（按 updated_at 倒序）|
| 点"新对话" | POST /api/threads | INSERT threads，返回新 thread_id |
| 切换 thread | GET /api/thread/{id}/history | 调 container 拉历史 JSON |
| 发消息 | POST /api/chat/start + GET /api/chat/stream | 见 8.2 |

---

## 9. Web 前端

### 9.1 路由结构

```
/                      → 已登录 ? /desktop : /login
/login                 → 微信 OAuth 入口 + 回调
/oauth/wechat/callback → 拿 code 换 token 写 session 跳 /desktop
/desktop               → macOS 桌面壳（onboarding 或主界面）
```

无登录态时除 /login 之外的页面都重定向到 /login。

### 9.2 桌面壳和 3 个 app

参考 `prototype/agentos-macos.html`，**视觉直接照搬**，但：

- **市场入口隐藏**：buildManageApp 不渲染"市场"tab，只显示"装备"tab，里头展示当前已开能力（默认全部）
- **购买套餐选择隐藏**：openPurchaseAssistant 直接进 provisionAssistant，跳过套餐选择对话框
- **微信一键登录改成正常微信 OAuth**（同样一个按钮，但点了走完整 OAuth flow）

#### App 1: 灵犀助理（chat）
- 左侧 sidebar：threads 列表 + "新对话" 按钮
- 右侧：当前 thread 的消息流 + 输入框
- 发消息：用 EventSource 连 `/api/chat/stream?thread_id=X&message=...`，逐 token 渲染

#### App 2: 我的助理（manage）
- 只渲染顶部装备区
- 列出默认能力（联网搜索 / 文件读写 / 微信收发），显示"已装备"
- "添加能力"按钮不渲染

#### App 3: 微信绑定（wechat）
- 未绑定：显示二维码 + 步骤说明，**真实**拉 iLink 二维码接口
- 已绑定：显示昵称 + 时间 + "解绑"按钮（解绑只把 wechat_sessions.status 改 'disabled'，不删 token）

### 9.3 onboarding 进度显示

进度页轮询 `GET /api/status` 拿 `progress_pct` + `provisioning_step`，匹配显示 6 步进度条。

---

## 10. 部署和网络

### 10.1 资源结构

```
Resource Group: rg-lingxi-prod
  ├── App Service Plan: asp-lingxi (B1)
  │   └── App Service: app-lingxi-gateway
  ├── Container Apps Environment: cae-lingxi (with VNet integration)
  │   └── 多个 Container App: hermes-<userid>
  ├── Container Registry: acrlingxi
  ├── Storage Account: stlingxi (for Azure Files)
  │   └── 多个 file share: user-<userid>
  └── Virtual Network: vnet-lingxi
      ├── subnet-app-service (App Service VNet Integration)
      └── subnet-aca (ACA Environment delegated)
```

### 10.2 网络拓扑

- ACA Environment：**internal ingress only**（不公网）
- App Service：开启 **VNet Integration** 接入同 VNet
- App Service 调 Container 用内网 URL（形如 `https://hermes-xxx.internal.<env-name>.<region>.azurecontainerapps.io`）
- 无应用层 auth（API Key / Managed Identity），靠 VNet 隔离

### 10.3 出口策略

- Container 出公网用默认（ACA Environment 自带 NAT），允许 Hermes 联网
- 必须列入网络白名单的服务：
  - Azure Files SMB（容器内挂载用，环境自动配）
  - Container Registry pull（拉镜像）
  - 各 LLM provider 的 API endpoint

### 10.4 成本（沿用架构总览，加 Supabase = $0）

| 用户规模 | 月成本（含 Supabase Free） |
|---|---|
| 10 人 | ~$14 + VNet $60 = **~$74** |
| 50 人 | ~$36 + VNet $60 = **~$96** |
| 100 人 | ~$139 + VNet $60 = **~$199** |
| 500 人 | ~$956 + VNet $60 = **~$1016** |

> VNet 是 ACA Environment 配 VNet 后的固定成本（~€2/天）。这是无应用层 auth 的代价。如果将来想省，再切换到 API Key auth + 公网 ingress。

---

## 11. MVP 实施分片

总工期估算 4-6 周（2 人）。

### Phase 1.1 — Container 基础（同事，并行）

**产出**：
- Hermes Docker Image（python:3.12-slim base + Hermes + 预装工具）
- Container 内 Python HTTP server（FastAPI/Starlette）
- 实现 §3 的 `POST /api/chat/start` + `GET /api/chat/stream` 接口
- 实现 §4 的 session 管理、文件系统约定、全自动批准
- 本地 `docker run` + curl 测试通过

**完成标志**：本地一行命令起容器，Gateway 调它能从一条 message 拿到完整 SSE 流和最终回复。

### Phase 1.2 — Azure 基础设施 + Gateway 骨架（我方，并行）

**产出**：
- **初始化 monorepo**：根 `package.json` + `pnpm-workspace.yaml` + `tsconfig.base.json` + `apps/gateway/` + `apps/web/` + `packages/shared/` + `infra/` 占位
- `packages/shared` 把 §3 / §6 的类型先落地（API 请求响应、DB row）
- Resource Group + ACR + Container Apps Environment（VNet 接入）+ Storage Account
- App Service B1 + Node 项目骨架（Express/Fastify）部署到 `apps/gateway/`
- Supabase 项目 + 表结构 + RLS（如需）
- §5 的目录结构和模块占位
- Azure SDK 实现 `provisioning/manager.ts`
- 测试：模拟一个 user_id，从 Gateway 调 Azure 起一个 Container 成功，状态写进 DB

**完成标志**：在 Postman 里 POST /api/purchase，能看到 container_mapping 状态从 provisioning → ready，Azure Portal 里看到 Container App 已创建。

### Phase 1.3 — Web 端到端（最优先）

依赖 1.1 和 1.2 完成。

**产出**：
- React + Vite 项目骨架，照搬 prototype 视觉
- 微信 OAuth 登录流程（/login + /oauth/wechat/callback）
- onboarding + 购买 + 进度页
- 主界面（macOS 桌面 + 3 个 app）
- App 1 聊天页（SSE 透传、新对话、thread 切换）
- App 2 装备页（静态显示默认能力）
- Gateway 的 /api/auth/* 、/api/purchase、/api/status、/api/threads、/api/chat/stream

**完成标志**：本地浏览器从注册到聊天端到端跑通。

### Phase 1.4 — 微信端到端

**产出**：
- iLink 长轮询管理器 + 启动恢复
- 扫码绑定流程（App 3 微信绑定页 + Gateway /api/wechat/* ）
- 微信消息收发链路：iLink 收消息 → dispatch → Container → 累积 → iLink 回复
- bot_token 过期处理（提前通知）

**完成标志**：用购买者本人的微信扫码绑定，在微信对话框跟 bot 聊天能拿到回复。

### Phase 1.5 — 部署 + E2E 验证

**产出**：
- VNet + ACA Environment + App Service VNet Integration 真实配置
- ACR 推 Hermes Image，Container App 用 ACR 镜像
- 域名 + SSL（App Service 自带）
- 真实部署后端到端验证：从公网注册 → 购买 → 绑微信 → 两端都能聊

### 关键 milestone

| Milestone | 完成标志 | 预计 | 
|---|---|---|
| **M1** | 1.1 + 1.2 完成，本地 + 模拟 provisioning 跑通 | 第 2 周末 |
| **M2** | 1.3 完成，本地浏览器端到端 | 第 4 周末 |
| **M3** | 1.4 完成，本地微信端能跑 | 第 5 周末 |
| **M4** | 1.5 完成，真实部署可用 | 第 6 周末 |

---

## 12. 待补 / 由其他人负责

| 项 | 负责人 | 状态 |
|---|---|---|
| Hermes 二进制/库获取方式（PyPI? git?） | 同事 | TBD |
| Hermes Docker Image 完整 Dockerfile | 同事 | TBD |
| Container HTTP server 具体框架（FastAPI / Starlette / aiohttp）| 同事 | TBD |
| 预装系统工具清单（git/gh/node/playwright 等）| 同事 | TBD |
| Image build & push 流程（手动 / CI）| 同事 | TBD |
| 微信开放平台企业资质申请 | 业务方 | TBD（影响 Phase 1.3 上线时间）|

---

## 13. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| Hermes Image 没按时交付 | Phase 1.1 阻塞，1.3 没法做完整链路 | 提前对齐 §3 接口契约，1.2 阶段先用 mock Container 跑 |
| 微信 OAuth 企业资质未到位 | 1.3 无法上线 | MVP 用临时邮箱登录骨架，资质到位后切换 |
| Supabase US 机房延迟超预期 | 用户体验差 | 实施 §5 内存缓存；不够再上 Pro Singapore |
| Azure VNet 配错导致 App Service 调不到 Container | 1.5 阻塞 | 1.2 阶段尽早试配，留出 buffer |
| Hermes 容器内并发 race（session_id 同时多请求）| 用户偶尔看到错乱回复 | 容器侧实现 SESSION_AGENT_LOCKS |
| iLink bot_token 24h 过期 | 用户感到中断 | 主动检测 + 前置 12h 通知用户重新扫码 |
| 全自动批准导致 Hermes 删错文件 | 用户数据丢 | MVP 用户即开发者，自己负责；Phase 2 加 approval UI |
| 国内 AI 服务备案 | 影响合规上线 | 单独走法务流程，技术上不阻塞 |

---

## 14. 与架构总览的差异点速查

| 项 | 架构总览（architecture-overview.md） | 本 Spec（2026-05-30）|
|---|---|---|
| 调度层 | A/B 待定 | **A 同步 HTTP/SSE** |
| 数据库 | SQLite / PG / Cosmos 待定 | **Supabase Free** |
| 前端 | 待定 | **React + Vite** |
| Auth | 待定 | **微信 OAuth + VNet 内网** |
| Gateway 接口 | 概述 | **§3 双点 SSE 契约** |
| 用户接入模型 | 朋友 → bot | **Phase 1 仅本人** |
| 套餐计费 | 待规划 | **MVP 全免费** |
| 多对话 | 未规划 | **Web 多 thread / 微信单 thread** |
| Approval | 未规划 | **MVP 全自动批准** |

---

> 写完了。下一步：你 review 这份 spec，提改动；改完之后进入 writing-plans 阶段，把这份 spec 拆成可执行的实施计划（task list、依赖图、验证标准）。
