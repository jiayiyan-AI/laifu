# 灵犀飞书渠道设计 (Feishu Channel)

- 日期: 2026-06-22
- 状态: 待评审
- 参照实现: `/Users/yanjiayi/workspace/openclaw` (`extensions/feishu/`, version 2026.4.20)
- 对标内部模块: `apps/gateway/src/wechat-ilink/`

## 1. 背景与目标

灵犀当前支持两个对话渠道:网页 (web) 和微信 (wechat / iLink)。本设计新增第三个渠道:**飞书 (Feishu / Lark)**,让用户在飞书里直接和自己的 Hermes 实例对话。

核心目标:用户在 laifu 网页点「绑定飞书」,扫码后(加一次企业管理员审批),即可在飞书私聊里和自己的 Hermes 收发消息。

## 2. 关键决策与取舍(已与产品确认)

| 维度 | 决策 | 理由 |
|---|---|---|
| 渠道定位 | 飞书作为**聊天渠道**(收发对话) | 与 web/wechat 对齐 |
| bot 粒度 | **1 laifu 用户 ↔ 1 自建飞书 app**,bot 只服务本人 | 贴近"一人一 bot"心智;app owner 即该用户 |
| 建应用方式 | **移植 openclaw 的 device-code 扫码建应用**,标识(`from=oc_onboard` / `tp=ob_cli_app` / UA / `openclaw_bot/ping`)**照搬** | 这是飞书↔openclaw 的专属 onboarding 通道;照搬标识飞书分不出我们,app 仍按 `PersonalAgent` 模板自动建好。产品已确认"用户看到 openclaw 字样可接受" |
| 收消息传输 | **WebSocket 长连接**(`@larksuiteoapi/node-sdk` 的 WSClient) | 契合 App Service always-on / 现有 iLink long-poll 模式;无需公网 webhook URL、签名校验 |
| 连接管理 | **每 binding 一条 WS**,由 `FeishuConnectionManager` 动态增删 | 对标微信 `PollManager`(N 条连接) |
| 凭证存储 | 每用户 `app_id/app_secret` **存 DB**(`feishu_bindings`) | 凭证用户自带,非全局;无需全局 `FEISHU_APP_ID` |

### 关于"扫码即用"的可行性结论(调研记录)

飞书**公开**的自建应用流程是纯手动(后台建应用、手动配权限、手动开长连接事件、发版)。openclaw 能"扫码即建好"靠的是 `accounts.feishu.cn/oauth/v1/app/registration` + `archetype:"PersonalAgent"` + 运行时 `/open-apis/bot/v1/openclaw_bot/ping`——这些**在飞书公开文档查无此物**,且端点 URL 硬编码 "openclaw",几乎可断定是飞书给 openclaw 的专属白名单集成。

本设计的选择是**搭便车**:原样复用 openclaw 的标识与端点。唯一无法绕过的人工步骤是**企业管理员在飞书后台 approve 一次应用版本**(openclaw 体验也是如此)。

## 3. 非目标 (YAGNI)

- 群聊 / @提及 / 卡片交互 / 文档评论事件
- 一个 app 服务多个用户(企业共享 bot)
- ISV / 应用商店模式
- Webhook 传输模式(只做 WebSocket)
- openclaw 的 doc / wiki / drive / perm 技能
- app_secret 的强加密(见 §9 待定项)

## 4. 端到端架构

```
[绑定期]
 laifu web「绑定飞书」
   → POST /api/feishu/bind/scan-start  (device-code init+begin)
   → 返回 qrUrl → web 展示二维码
   → 用户用飞书 App 扫码 → 后端轮询 registration
   → 拿到 app_id / app_secret / domain / owner open_id
   → 落 feishu_bindings 行 (status='pending_approval')
   → web 提示:企业管理员后台 approve 应用版本 (给后台深链)
   → 用户点「我已审批」→ POST /api/feishu/bind/activate
       → openclaw_bot/ping 探针验活 + 起 WS
       → 成功: 建 thread(source=feishu), status='active'

[运行期]
 FeishuConnectionManager (开机 startAll, 每 active binding 一条 WSClient)
   → im.message.receive_v1 事件
   → 校验 sender open_id == binding.owner_open_id (否则忽略/回"私有 bot")
   → dispatchHermesChat({ source:'feishu', sessionId:'feishu:<thread>', loopId })
   → 存 reply ctx 到 feishuReplyContexts[loopId]
   → 容器异步 POST /internal/hermes-callback
   → source==='feishu' 时调 feishuReplier(threadId, reply)
   → 用该 app 的 client 调 im.message.create(receive_id=owner_open_id) 发回飞书
```

要点:**完全复用** `dispatchHermesChat` + `/internal/hermes-callback` 异步回调链(与微信一致),天然绕开 ACA ingress 超时(known-issues #2)。

## 5. 绑定流程详细

### 5.1 路由 (`apps/gateway/src/api/feishu-bind.ts`)

- `POST /api/feishu/bind/scan-start` — 起 device-code 流程,返回 `{ qrUrl, deviceCode, expireIn, interval }`。
- `POST /api/feishu/bind/scan-poll` — 前端长轮询(对标微信 `qr-start` + `qr-poll`),透传 registration poll 结果;成功时落 `pending_approval` binding,返回 `app_id` + 后台深链。
- `POST /api/feishu/bind/activate` — 探针验活 + `connMgr.startOne(binding)`;成功置 `active` + 建 thread。
- `POST /api/feishu/bind/unbind` — `connMgr.stopOne` + `dao.feishuBindings.deactivate`。

所有路由走 `requireSession`(已登录用户)。绑定与用户 1:1(`user_id` unique,重复绑定走 upsert)。

### 5.2 device-code 实现 (`apps/gateway/src/feishu/registration.ts`)

移植 openclaw `extensions/feishu/src/app-registration.ts`:
- `initAppRegistration()` / `beginAppRegistration()`(`action: begin, archetype: "PersonalAgent", auth_method: "client_secret", request_user_info: "open_id"`,QR 参数 `from=oc_onboard`/`tp=ob_cli_app`)
- `pollAppRegistration()`(轮询 `action: poll`,处理 `authorization_pending`/`slow_down`/`access_denied`/`expired_token`,自动检测 feishu/lark 域)
- `getAppOwnerOpenId()`(换 tenant_access_token → 查 app owner open_id)

返回 `{ appId, appSecret, domain, ownerOpenId }`。

## 6. 运行时

### 6.1 连接管理器 (`apps/gateway/src/feishu/connection-manager.ts`)

对标 `wechat-ilink/poll-manager.ts`:
- `startAll()` — 启动时从 `dao.feishuBindings.listActive()` 拉起每条 WS。
- `startOne(binding)` / `stopOne(bindingId)` / `stopAll()`。
- 每条连接持一个 Lark `WSClient`(由 `client.ts` 用 binding 的 `app_id/app_secret/domain` 创建),注册 EventDispatcher。

### 6.2 客户端封装 (`apps/gateway/src/feishu/client.ts`)

移植 openclaw `client.ts` 关键部分:`createFeishuClient` / `createFeishuWSClient` / `createEventDispatcher`,以及 `sendMessageFeishu`(`im.message.create`,`receive_id_type=open_id`)。tenant_access_token 由 SDK Client 自动管理。

### 6.3 入站处理 (`apps/gateway/src/feishu/inbound-handler.ts`)

对标 `wechat-ilink/inbound-handler.ts`:
- 解析 `im.message.receive_v1`,提取 sender open_id / message_id / 文本。
- **去重**:`message_id` 进程内 LRU(单进程够用;容器侧 message 落库本身幂等)。
- **鉴权**:`sender open_id !== binding.owner_open_id` → 忽略(或回一句"这是私有助手")。
- 解析 thread(binding.thread_id);quota / 容器就绪检查(复用 web/wechat 同款)。
- 存 reply ctx 到 `feishuReplyContexts`(键 loop_id,值含 client + owner open_id),再 `dispatchHermesChat({ source:'feishu', ... })`。
- 硬截止 `HARD_DEADLINE_MS`(复用现有常量),超时标 loop fail + 清 reply ctx。

### 6.4 探针 (`apps/gateway/src/feishu/probe.ts`)

移植 openclaw `probe.ts` 的 `POST /open-apis/bot/v1/openclaw_bot/ping`(`needBotInfo:true`),用于 activate 时验活 + 取 bot open_id。

## 7. 数据模型 (`packages/db/src/schema.ts`)

新增表(对标 `wechat_bindings`,迁移文件递增编号):

```ts
export const feishuBindings = pgTable('feishu_bindings', {
  id:            uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  user_id:       uuid('user_id').notNull().unique(),          // 1:1 用户
  app_id:        text('app_id').notNull().unique(),           // 自建 app
  app_secret:    text('app_secret').notNull(),                // 敏感, 见 §9
  domain:        text('domain').notNull().default('feishu'),  // 'feishu' | 'lark'
  owner_open_id: text('owner_open_id').notNull(),             // 扫码者 = 唯一用户
  thread_id:     text('thread_id'),                           // 默认 thread
  status:        text('status').notNull().default('pending_approval'), // 'pending_approval' | 'active'
  is_active:     boolean('is_active').notNull().default(true),
  bound_at:      timestamp('bound_at').defaultNow().notNull(),
}, (t) => [
  index('idx_feishu_bindings_active').on(t.is_active).where(sql`is_active = true`),
]);
```

enum 扩展:
- `messageSourceEnum`: `['web', 'wechat']` → 加 `'feishu'`(`schema.ts:201`)。

DAO:`apps/gateway/src/db/feishu-binding-dao.ts`,接口对标 `wechat-binding-dao.ts`:`listActive / getByUserId / upsertByUserId / setActive / bindThread / deactivate`。在 `db/index.ts` 的 Proxy 工厂里注册 `feishuBindings`。

## 8. 对现有代码的改动点

1. `packages/db/src/schema.ts` — 新表 + `messageSourceEnum` 加 `'feishu'`;`pnpm db:generate` 出迁移。
2. `apps/gateway/src/lib/aca-call.ts` — `source` 注释从 `'web' | 'wechat'` 扩到含 `'feishu'`(类型本就是 `string`,无需改类型)。
3. `apps/gateway/src/api/internal-callback.ts` — `source` 类型 `'web' | 'wechat'` → 加 `'feishu'`(`:53` `:74`);新增 `feishuReplier?` dep + `source === 'feishu'` 分支(对标 `:127` 的 wechat 分支)。
4. `apps/gateway/src/index.ts`:
   - 新增 `FeishuConnectionManager` 的 import / 构造 / `startAll` / `stopAll`(对标 `pollMgr` 在 `:260/:263/:284`)。
   - `CreateAppOptions` 加 `feishuMgr?`;条件挂 `buildFeishuBindRouter`(对标 `:106` 的 `opts.pollMgr`)。
   - 定义 `feishuReplier`(遍历 `feishuReplyContexts`,对标 `:119` 的 `wechatReplier`),传入 `buildCallbackRouter`。
5. `apps/gateway/src/config.ts` + `.env.example` + `infra/bicep/main.bicep` — 加 `FEISHU_ENABLED`(默认 off)+ `FEISHU_DOMAIN`(默认 `feishu`)。**遵守 env 三处守则**。无敏感全局值(凭证在 DB)。

## 9. 风险与待定项

1. **DB 明存 `app_secret`**(敏感)。微信现状是明存 `bot_token`,本设计默认对齐(明存),但**标为待定**:是否在 binding 落库前用 KMS / 应用层密钥加密。**实现前需产品/安全拍板**。
2. **强耦合 openclaw 飞书专属端点**(`oc_onboard` onboarding 通道 + `openclaw_bot/ping`)。飞书若调整/收回这条通道,绑定与验活会断。属已知接受风险(产品已确认搭便车)。
3. **单进程 N 条 WS**。MVP 量级(几十~上百用户)在一个 App Service B1 进程内可接受;规模上来需评估拆分或限流。
4. **`@larksuiteoapi/node-sdk` 打包**。gateway 经 `scripts/build-deploy.sh` 走 vite lib mode 单文件;该 SDK(纯 JS + ws)理论可打包,但**需冒烟验证**(对照 smoke-test-before-done 记忆:交付前真跑 `pnpm dev` + 部署冒烟)。
5. **扫码者须是飞书企业管理员/开发者**(有建应用权限),普通员工绑不了。属平台硬限制,文案需说明。
6. **唯一人工步骤**:企业管理员后台 approve 应用版本。绑定 UI 需清晰引导(后台深链 + "我已审批"再验活)。

## 10. 测试

- 单测:镜像 `test/wechat-ilink/*` 结构。覆盖 device-code registration(mock fetch)、inbound 解析 + open_id 鉴权 + 去重、`feishuReplier` 回复路径、binding DAO。
- 冒烟(交付前必须,见 smoke-test-before-done 记忆):真跑 `pnpm dev`,验证 gateway 起 WS 不崩、绑定路由可达;部署后验证 SDK 打包正常。
- async handler 一律包 try/catch(见记忆 smoke-test-before-done)。

## 11. 分期

- **MVP(本 spec)**:单用户私聊文本收发,扫码建应用 + 审批 + WS。
- 后续:群聊/@、卡片、app_secret 加密、规模化连接管理。
