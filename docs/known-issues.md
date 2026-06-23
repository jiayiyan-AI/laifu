# 已知问题与运行规则

> 配套：[architecture.md](./architecture.md) · [deployment.md](./deployment.md) · `docker/hermes/`

---

## 🔴 必须遵守的规则

### #1 任何上 ACA 的 HTTP server 必须支持并发

- **原因**：ACA 的 readiness/liveness probe 每 5s 打一次 `/health`, 5 次失败后强杀容器。单线程 server 处理 chat 时无法响应 health, 必死。
- **规则**：
  - HTTP server 必须能并发处理请求 (Python 用 `ThreadingHTTPServer`、Node 默认 event loop 即可)
  - `/health` 必须独立、轻量、不与业务共享阻塞资源
  - 本地测试矩阵应加"并发 chat + health"组合
  - Azure 出诡异行为先翻 `az containerapp logs show --type system`
- **现状**:`docker/hermes/server/index.ts` 用 `node:http` event loop 模型实现 (Bun + TS, 前身 Python `server.py` → Node `server.mjs`)。**加新容器时这条规则仍然适用**。

---

## 🟡 当前未触发但留意

### #2 ACA Ingress 4 分钟超时

- **现象**：单个 HTTP 请求超过 240s 会被 ACA Ingress 强切, 返回 504。
- **本质**：Consumption-only 环境的 ingress idle timeout **固定 240s 且不可配** (envoy 写死)。"idle" 指的是这条 TCP 连接 4 分钟内没有任何字节流动 — **不是绝对耗时**, 这是后续绕开方案的关键。
- **当前架构**：Gateway → Container 用同步 `POST /chat` 调用 (`apps/gateway/src/lib/aca-call.ts`), 受这个上限制约。
- **实测**：2026-06-05 wechat 链路一次 240015ms (≈240s 整) → `http_504`, 来源是平台返回不是 hermes。同一链路下一条 chat 38s 成功。指标现埋在 `event=aca.chat.dispatch`(端到端按 thread_id 关联 callback, 见 `docs/log.md` §9.3), KQL 见 `docs/log.md`。

#### 绕开方案 (按性价比排序)

##### 方案 1：gateway↔ACA 这段改流式 / 心跳保活 (推荐, 0 成本)

利用 "idle timeout 只看字节流动" 的特性, 保证 `gateway → ACA /chat` 这段连接每 < 240s 内必有字节流动, ingress 就不会砍。

改动只在 **`docker/hermes/server/` + `apps/gateway/src/lib/aca-call.ts`**, 对外接口 (`POST /api/chat` / 微信 inbound) 形状不变, 前端 / 微信侧零改动。

落地清单：

- server/http.ts `/chat` 改 SSE 输出:`Content-Type: text/event-stream`, 立即 flush headers
- 另起 heartbeat 线程, 每 30s 写一帧 `: heartbeat\n\n` (SSE 注释帧, 不算 data)
- hermes 跑完后写 `data: {"done":true,"reply":"..."}\n\n`
- 待验证：Hermes CLI `-Q -q` 模式 stdout 是不是增量打印 token。如果是, 顺手把每段 token 作为 `data: {"delta":"..."}` 推出去, 给将来做前端流式打字效果留接口
- gateway `aca-call.ts` 不再 `await resp.json()`, 改读 `resp.body.getReader()` + SSE 解析, 收到 `done` 帧才 resolve, 对外仍返回 `{ ok, reply }` 不变
- gateway `fetch` AbortSignal timeout 设大 (如 30 分钟)
- 微信入站 `apps/gateway/src/wechat-ilink/poll-loop.ts` 的 timeout 同步调高
- hermes 自身 `HERMES_TIMEOUT` (server/config.ts 默认 14400s) 如已被人手动调小, 重新调高, 否则它就是新的天花板

效果：240s → 实际可达数十分钟到小时级。

##### 方案 2：切异步 Job 队列 (架构变更, 见 `architecture.md` 方案 B)

gateway 收 chat 立刻 ack, hermes 后台跑, 完了回调 gateway, gateway 通过 SSE / 微信 sendText 推给用户。彻底无超时, 但改动面大 (DB 队列表 / worker / 回调端点 / 前端等待 UI)。真长任务才值得做。

##### 方案 3：升级 ACA Premium Ingress

`requestIdleTimeout` 可调到 30 分钟。但 CAE 必须切 workload profile 模式, 至少 2 节点 (D4 起) 24/7 常驻 → **+$280-350/月**。当前 dev 盘子 ~$50/月, **跳过**。

#### 不要做的

- 在 `aca-call.ts` 里调 `/chat` 前先打 `/health` probe 预热 — 让所有请求多一次 RTT, 得不偿失。之前试过又回滚, 冷启动判断改成 join `ContainerAppSystemLogs_CL` 的 scaler 事件, 见 `docs/log.md` §9.5。
  - **例外 (2026-06, 微信图片附件)**: files 链路 (`container-warm-cache.ts` 的 `ensureContainerWarm`) **有图时**会先 `GET /health` 唤醒再开 streaming pipeline。原因不同于上面的"省 RTT": files 把 CDN 连接挂在冷启动窗口里, 微信 CDN ~30-60s idle timeout 必 RST 整张图作废, 所以必须先唤醒。text `/chat` 路径**仍不加 probe**, 本条结论不变。详见 `docs/todo/weichat-file-impl.md` §3.7。


---

## 🟢 已知能接受 (短期不处理)

### #3 ~~`tirith security scanner` 警告污染回复~~ — **已修**

- 历史现象:每次 `/chat` 响应正文前会多一行 `⚠ tirith security scanner enabled but not available ...`
- 修法:`docker/hermes/server/hermes-proc.ts:cleanReply()` 把 `⚠️ / ⚠ / [server]` 开头的行整行剔除, `callHermes()` / `asyncChatAndCallback()` 调用。
- 留作记录: hermes 上游版本若改告警前缀, 这个清洗逻辑要跟着更新。

### #4 PATH 中 `~/.local/bin` 优先于 `~/.npm-global/bin`

- **现象**：同名命令时 pip 版本优先于 npm 版本 (`docker/hermes/Dockerfile:75`)。
- **影响**：真实场景工具命名极少冲突。
- **应对**：不管。

### #5 Hermes 主动"教育"用户用结构化 memory 而不是 .txt

- **影响**：测试方法选择问题, 与架构无关。
- **应对**：真实平台上 Hermes 自己用 `~/.hermes/memories/` 管理。

### #8 `az containerapp exec` 引号嵌套地狱 — 用 stdin + base64 绕开

- **现象**: 想在 ACA 容器里跑一段稍复杂的脚本 (含引号、`>`、heredoc), 用 `az containerapp exec --command "sh -c '...'"` 各种形式拼, 远端会报 `Syntax error: Unterminated quoted string`、`grep: Trailing backslash`、或者本地 sh 直接把脚本当文件名解析。原因: 本地 zsh / az CLI 命令行 / 远端 sh 三层都有自己的引号处理, 互相吃逃逸字符, inline heredoc 在 ws 通道上也基本传不过去。
- **解决手势**: 把脚本 base64 编码后从 stdin 喂给目标解释器, 命令里只有一段裸 base64 字符串, 完全没引号要逃。

  ```bash
  # 1. 本地把脚本编码 (注意 printf 不加末尾换行, 不要用 echo)
  B64=$(printf '%s' "$PYSCRIPT" | base64 | tr -d '\n')

  # 2. 远端解码后 pipe 给 python3 (其他解释器同理: bash、node 都行)
  script -q /dev/null az containerapp exec -g $RG -n $APP \
    --command "sh -c \"echo $B64 | base64 -d | python3\""
  ```

  关键: 外层 `--command` 用双引号包, 内层 sh 命令也用双引号, 中间的 `$B64` 在本地展开成一长串无引号的安全字符 (base64 字母集本身无 shell 特殊字符), 远端 sh 拿到的就是 `echo XXX... | base64 -d | python3`, 一路畅通。
- **何时用**: 任何想在 ACA 容器里跑超过单行简单命令的场景 — sqlite probe / 临时数据迁移脚本 / 调 SDK 测试连通性都适用。`docs/poc.md` Step 7 就是按这个手势跑通的。
- **替代方案**: 把脚本预先打进镜像 (`COPY scripts/`) 然后 exec 调用 — 一次性临时用嫌重, 长期调试工具值得做。

### #7 `ContainerMappingCache` 是进程内 Map, 没有 TTL / 失效机制

- **现象**: 在 PG 里手动清掉 `container_mapping` 行 (例如 dev 环境清理孤儿数据), gateway 仍然认为容器存在 — 下游 `/api/entitlements/cloud/enable` 等接口拿陈旧的 `container_name` 去 ACA 找不到, 返回 500 `ResourceNotFound`。
- **原因**: `apps/gateway/src/db/cache.ts:ContainerMappingCache` 启动时 `loadAll()` 把整张表读进内存 Map, 之后只在 `purchase` / `provisioning` 路径主动 `set()`. 没有任何机制把外部数据库改动同步回缓存。
- **应对** (运维侧):
  - dev 环境清完 DB, **重启 App Service** (`az webapp stop && az webapp start`, 注意 `restart` 不一定真重启 worker) 让 gateway 重读
  - 生产应避免手动改 DB; 用 admin 接口去删
- **何时根治**: 加 LISTEN/NOTIFY 监听或定时 reload 才能彻底; 目前用户量小, 不值当。

### #9 App Service Key Vault reference cache 启动失败后不会自动重 resolve

- **现象**: 新 KV 刚创建时 secret 还没灌, 但 App Service 已经先部署 — gateway 启动时所有 KV reference 状态 `SecretNotFound`, node 进程 exit 1 (`error: connect ECONNREFUSED` 之类 PG 连不上的错), App Service stuck 在 startup failure 循环。后来灌好 secret + `az webapp restart` 仍**不会**触发重 resolve, 状态依然 `SecretNotFound`。
- **原因**: App Service 那层有自己的 KV reference cache, restart 只是重启 worker, 不刷 cache。Cache 只在 **app settings 实际变更**时刷新, 普通 restart 不触发。
- **正确顺序 (新环境首次部署)**:
  1. `./deploy.sh dev` 建好 KV + role assignment
  2. **回灌 9 个 secret** (灌到 KV; 真实清单见 [deployment-azure-first-run.md](./deployment-azure-first-run.md) §"下次部署 prod 环境")
  3. 再 `az webapp deploy --src-path deploy.zip` 部署代码
- **已发生的灾难恢复手势**:
  ```bash
  # 触发 appsettings 变更 → 强制 App Service 重读所有 KV reference
  az webapp config appsettings set -g rg-lingxi-dev -n app-lingxi-dev-gateway \
    --settings "KV_REFRESH_TRIGGER=$(date +%s)" --output none
  # ~30 秒后所有 reference 转 Resolved, app 自动重启成功
  ```
- **验证 KV reference 实时状态** (不在 portal 里翻):
  ```bash
  az rest --method get --url "https://management.azure.com/subscriptions/<SUB>/resourceGroups/rg-lingxi-dev/providers/Microsoft.Web/sites/app-lingxi-dev-gateway/config/configreferences/appsettings?api-version=2022-03-01" \
    --query "value[].{name:name, status:properties.status}" -o table
  ```
  正常应该全是 `Resolved`; 出现 `SecretNotFound` / `AccessDenied` 就走上面的手势。
- **更深层根治**: 把 KV secret 写入也搬到 Bicep (用 `Microsoft.KeyVault/vaults/secrets` 资源声明), deploy 完 secret 就齐, 永远不会出现 "代码到了但 secret 没到" 的窗口。当前是手动灌, 因为某些 secret 是从第三方 (Google OAuth / Anthropic) 拿到的, Bicep 里写明文不合适。

### #10 ACA 容器 `no_new_privs=true` 禁 sudo, subPath 子目录 owner 必须用 initContainer 修

- **现象**: 用 `volumeMount.subPath` 让多用户共享 NFS share 时, ACA 自动 mkdir 出的子目录 owner=root:root, 0755。主容器以非 root 用户 (hermes UID 1000) 启动时, 第一行 `touch /home/hermes/.initialized` 就 `Permission denied` 报错挂掉。试图在 entrypoint 里 `sudo chown hermes:hermes /home/hermes` 修也失败:
  ```
  sudo: The "no new privileges" flag is set, which prevents sudo from running as root.
  sudo: If sudo is running in a container, you may need to adjust the container configuration to disable the flag.
  ```
- **原因**: ACA 默认给所有容器开 `no_new_privs=true` 这个 Linux kernel 安全 flag, **禁止任何 setuid 提权, 连 sudo 都不行**。这是平台层硬限制, 用户改不了 (类似坑 #9 的 KV cache, 平台底层 behaviour)。
- **关键发现**: ACA `BaseContainer` schema **没有 `securityContext` / `runAsUser` 字段**, 不能在 container 配置里 override image 的 USER。
- **正解 — initContainer**:
  - ACA 支持 `template.initContainers`, 它们以 image 默认 USER 启动 (跑完 exit 0 才启动主容器)
  - 用一个**默认 USER 是 root 的 image** (我们用 `mcr.microsoft.com/cbl-mariner/busybox:2.0`, 微软 Mariner busybox, ~2MB, 公网可拉)
  - init container 挂相同 volume + 相同 subPath, 跑一行 `chown 1000:1000 /home/hermes`
  - 主容器 (hermes image, USER hermes) 起来时 owner 已正确, 干净启动
- **实现位置**: `apps/gateway/src/provisioning/azure.ts:createContainerApp` 的 `template.initContainers`。完整方案见 [nfs.md §十](./nfs.md#十-多租户共享-share--subpath-隔离-2026-06-03-已落地)。
- **诊断手势**:
  ```bash
  # 看容器 console (会看到 sudo 错或 Permission denied 之类)
  WS=$(az monitor log-analytics workspace list -g rg-lingxi-dev --query "[0].customerId" -o tsv)
  az monitor log-analytics query -w "$WS" --analytics-query \
    "ContainerAppConsoleLogs_CL | where ContainerAppName_s == '<NAME>' \
       | where TimeGenerated > ago(15m) | order by TimeGenerated desc | take 30 \
       | project TimeGenerated, ContainerName_s, Log_s" -o tsv
  ```
- **后人警告**: 任何"在 ACA 容器内提权"的方案 (sudo / setuid 二进制 / 改文件 mode 0777 然后 chown) 都因为 `no_new_privs` 失效。**唯一通用解就是 initContainer 用 root image**, 别再试别的方向。


---

### #11 微信 `/new` 指令不会真正切换 session — server/ session map 不更新

- **现象**：微信用户发 `/new`，Hermes CLI 内部新建了 session 并回复「已新建会话」，但后续消息仍然 `--resume` 旧 session。导致 model 不更新、上下文不重置。
- **根因**：涉及三层问题：
  1. **Gateway 层**：微信 binding 绑定 1 个 thread_id 后永不更新（`resolveThread` 中 `if (binding.thread_id) return`），所以 session_name = `wechat:<threadId>` 永远不变。
  2. **server/chat.ts 层**:`callHermes` 中只有 `not existing` 时才走 detect + put 更新 `_gateway_session_map.json`。当 existing 有值时,即使 Hermes 内部切了 session,map 也不会更新。
  3. **结果**：后续请求还是 `--resume <旧hermes_uuid>` → 旧 session → 旧 model。
- **影响**：微信用户无法通过 `/new` 切换到新模型配置；usage_events 中 model 字段停留在旧值。
- **临时绕过**：手动清掉 binding 的 thread_id：`UPDATE wechat_bindings SET thread_id = NULL WHERE user_id = '...'`，下次发消息会新建 thread → 新 session。
- **修复方向**：
  - 方案 A:server/chat.ts 在 `existing` 有值时也检测 Hermes stdout 中的 session 切换信号,更新 map。
  - 方案 B：Gateway 层识别 `/new` 指令，主动新建 thread + 清 binding 的 thread_id，让 session_name 变化。
  - 方案 C:两层都改 — Gateway 感知指令 + server/chat.ts 容错检测。

---

## 🧹 周期性手动维护清单

Azure 这套资源里, 大多数老资源会自动 GC, 但有几样**只有手动才会消失**, 不维护就累积。

### M1 ACR 老镜像 tag — 手动删

ACR Basic SKU 没有 retention policy, 每次 `build-and-push.sh` 推新 tag 老 tag 原地不动。

**何时清**: tag 数 > 5, 或接近 ACR 10 GB 存储上限 (`az acr show-usage -n acrlingxidev`)。
**保留**: 永远留 active 那一版 + 至少 1 个回滚保险版。

```bash
# 看现状
az acr manifest list-metadata -r acrlingxidev -n hermes \
  --query "[].{tags:tags, digest:digest, created:createdTime}" -o table

# 删指定 tag
az acr repository delete -n acrlingxidev --image hermes:v3 --yes
```

### M2 存量用户 ACA env / image 升级 — ✅ 已自动化 (2026-06-18)

~~改了 ACA spec 后存量用户不会自动跟着切, 需手动批量推。~~ 已由 gateway 声明式 reconcile 取代 (见 `dynamic-update-aca.md`)。

`buildContainerAppSpec` 是 ACA spec 的唯一事实源; gateway 启动算 `policyHashFor` 常驻内存, 每个 `container_mapping` 行记录其 ACA 已应用的 `policy_hash`。改 spec 代码 (含写死的 `config.azure.hermesImageTag`) → 部署 gateway → boot sweep + lazy reconcile 自动把存量用户拉齐, `scripts/rollout-hermes.sh` 已删除。

**现在的心智**: 改了任何 ACA spec 相关的东西 (镜像 / env 结构 / resources)? 改对应代码 (动镜像就 bump `config.azure.hermesImageTag = 'hermes:vN'`) + 部署 gateway。完事。

### M3 NFS share quota — 按需扩容

`hermes-shared` (Premium FileStorage) 当前 100 GB quota, 按 quota 计费 (~$16/月) 不按使用量, **超 quota 写入会失败**。

**何时扩**: 用户数增长导致总占用接近 quota 时。
**怎么扩**: `az storage share update --name hermes-shared --account-name stnfslingxidev --quota <new GB>` (秒级生效, 不重启)。
**注意**: 实际使用量 Premium FileStorage 不暴露在 mgmt API, 要登容器 `df -h /home/hermes` 查。

### M4 自动 GC 的, 不用管

- **KV 软删 secret**: 7 天后自动 purge
- **ACA revisions**: 默认最多 100 个, 到上限自动清最老
- **App Service Kudu deployments**: 自动滚动覆盖
- **Log Analytics**: retention 30 天自动删

---

## 🟢 已修复 (保留作为踩坑记录)

### #6 ~~Hermes `state.db` 在 Azure Files (SMB) 上写不进去, 多轮对话上下文全丢~~ — **已修 (2026-06-03)**

> **修复方案**: 整盘换 NFS 4.1 — Premium FileStorage + VNet (Service Endpoint) + ACA `nfsAzureFile` binding。详见 [nfs.md](./nfs.md)。
>
> **验证**: 端到端跑通, `GET /api/threads/:id/messages` 不再 502, 历史对话正常回显。容器内 sqlite probe 三种 PRAGMA 全 OK (vs SMB 时单连接零竞争都失败)。
>
> 下面的现象/排查/根因/方案对比段落原样保留, 它们记录了完整的论证过程, 是未来类似"网络存储 + 文件锁"调试的参考样本。新人接手时只需要知道结论, 不需要重读。

#### 表面现象

- Web 端打开一个**昨天聊过的旧对话**，前端立刻请求 `GET /api/threads/:id/messages` 拿历史 → **502 Bad Gateway**，响应体 `{"error":"container returned 500"}`
- 微信入站 (`/wechat`) 触发的 thread 同样会复现
- 不是稳定 502，是间歇 —— 偶尔能拿到 200，但返回的 `messages` 是空数组

#### 排查证据

调用链:浏览器 → gateway `GET /api/threads/:id/messages` (`apps/gateway/src/api/chat.ts:67`) → 容器 `GET /history` (`docker/hermes/server/http.ts handleHistory`) → `loadMessagesByUuid()` (`docker/hermes/server/state-db.ts`) → `bun:sqlite` 直读 `state.db`

Log Analytics 查询 (`ContainerAppConsoleLogs_CL`) 多次命中：

```
[server] load_history failed: database is locked
[server] GET /history?session_id=web%3Athr_xxx HTTP/1.1  500
```

进容器 (`az containerapp exec`) 验证文件状态：

| 路径 | 状态 |
|------|------|
| `/home/hermes/.hermes/state.db` | **0 字节**, 最后修改时间停在容器启动后不久 |
| `/home/hermes/.hermes/sessions/` | 空目录 |
| `/home/hermes/.hermes/_gateway_session_map.json` | 正常更新, 包含 `web:thr_xxx → 20260603_xxx_xxx` 的映射 |

#### 根因

**SQLite + Azure Files (SMB 协议) 文件锁不兼容**。

Hermes 用 SQLite 文件 `state.db` 存所有 session 数据。Azure Files 默认对外暴露 SMB 协议端点, 容器把 `/home/hermes` 通过 SMB 挂载 (`mount` 输出确认: `cifs vers=3.1.1`, 无 `nobrl` 选项)。

SQLite 在打开数据库时就会用 `fcntl(F_SETLK)` 尝试拿 reserved/exclusive byte-range lock 初始化文件 — **即使没有其他进程访问, 这一步也必跑**。Azure Files SMB 服务端对 byte-range lock 的实现历史上不可靠 (Linux 内核 CIFS 客户端已知问题), SQLite 拿不到肯定答复立刻判 `SQLITE_BUSY`。SQLite 官方文档明确警告: **强烈建议避免在网络文件系统上使用 SQLite**。

**实证 (2026-06-03 在容器 `hermes-8a599ed4` 内跑的 probe)**:

| 测试 | 结果 |
|------|------|
| `/tmp` (容器本地 tmpfs), 单连接新文件, 建表+INSERT | ✅ OK |
| `/home/hermes/.hermes/` (SMB), 单连接新文件, 建表+INSERT | ❌ `database is locked` |
| 同上 + `PRAGMA journal_mode=wal` | ❌ 连 PRAGMA 都执行不了 |
| 同上 + `PRAGMA locking_mode=EXCLUSIVE` | ❌ PRAGMA 能执行, INSERT 失败 |

**关键结论: 不是"有竞争才坏", 是"动 SQLite 就坏"**。无任何竞争的全新文件, 用唯一一个连接做最简单的写, 在 SMB 路径上直接失败。WAL / EXCLUSIVE / 只读 + retry 等"调连接参数"的方向已被实证排除。

实际触发的失败链：

1. Hermes chat subprocess 执行成功, stdout 返回 reply, gateway 拿到响应 200 OK
2. 但 hermes 内部把 message 持久化进 `state.db` 这一步在 SMB 上拿锁失败 → 文件停留在 0 字节
3. 下一次 `GET /history` 进来, 打开同一个文件再次拿锁失败 → `database is locked` 异常 → 容器 500 → gateway 502

普通文件 IO (如 `_gateway_session_map.json` 374B、`config.yaml` 850B、`models_dev_cache.json` 2.16MB) 走 SMB 完全正常, 不依赖 `fcntl` 字节范围锁。**只有 SQLite (以及任何依赖 POSIX advisory lock 的工具) 踩坑**。

#### 衍生影响（比 502 严重得多）

`callHermes` (`docker/hermes/server/chat.ts`) 调 hermes CLI 时用 `--resume <uuid>` 让 hermes 从 `state.db` 恢复历史 context。由于 db 是空的, **每条消息进入 hermes 时都没有任何历史 context, 等于每次都是全新对话的第 1 轮**。

表现为：

- 多轮对话上下文全断 ("你叫什么名字" → "我叫小明" → "我叫什么" 会答不上)
- hermes 的 memories / SOUL 主动学到的人设也不会沉淀到 db
- LLM 每次输入 token 都在低水位, 看似省钱实际是功能没实现
- 微信入站走同一路径, 同样受影响

**当前服务端从未真正记住任何对话, 整个对话应用本质上以 stateless 单 turn 在跑**。

#### 候选方案与权衡

> ⚠️ 后续调研发现 SQLite 雷区不止 hermes 一家踩 (pip cache、npm cacache、playwright cookies、Agent 帮用户写的 `db.sqlite3` 都是 sqlite, 都依赖 `fcntl` 锁)。**任何"只解 hermes 一家"的局部方案都不彻底**, 因为只要 home 还在 SMB 上, Agent 跑无关任务时仍会随机崩。
>
> **当前决策**: 直接走 **方案 B (切 NFS 4.1)**, 详细落地见 [nfs.md](./nfs.md)。下表保留是为了记录论证过程, 别按这个表选了。

按"成本 / 工程量 / 根治程度"排序：

| 方案 | 月成本增加 | 工程量 | 根治程度 | 备注 |
|------|----------|------|---------|------|
| A. `state.db` 走容器本地盘 + 定期导出回 Azure Files | $0 | 小 (改 entrypoint + server/) | ⚠️ **只解 hermes 一家**, pip/npm/playwright/用户项目仍踩雷 | 早期文档里以为是首选, 现已降级 |
| **B. Azure Files 切到 Premium FileStorage + NFS 4.1 协议** | **~$16/月/用户** (实际部署 Provisioned v1, 100 GiB share × $0.16; 早期文档错把 v2 单价 $3.2 当成 v1, 已校正; v2 切换列入 [nfs.md §十](./nfs.md#十-未来优化-v1--v2-切换-todo-高优先级) 高优先 TODO) | 当前无存量用户场景下**小** (destroy-recreate dev/prod, 见 [nfs.md](./nfs.md)) | ✅ **全面根治**, 救活所有 SQLite 用户 | 已选定。VNet 走 Service Endpoint 即可, 不必上 Private Endpoint, 无 €2/天费用 |
| C. gateway 把消息历史改写到 PG 当权威源 | $0 (走现有 PG) | 大 (动 gateway + 数据模型 + 重做 prompt 组装) | ⚠️ **只解 hermes 一家**, pip/npm/playwright 仍踩雷 | 解决的是 hermes 这一家的 db 问题, 不解决 SMB 整体不能 host sqlite 的根本矛盾 |
| D. 只在 `server/state-db.ts` 加 `mode=ro` 只读 + retry | $0 | 极小 | ❌ **已实证无效** | 写入会失败, 多轮 context 问题不解决; 而且 SMB 上连读路径也是先拿锁, 仍会 `database is locked` |

不可行的方案 (已实证或权威排除):

- **把整个 `/home/hermes` 搬出 Azure Files**：违反架构核心 (`architecture.md` 第三/五章 "每用户一个 volume、整盘挂载"), 否决
- **Premium SMB**：SMB 协议层 advisory lock 缺陷依然存在, SKU 换不掉, 否决
- **CIFS mount 加 `nobrl` 关掉字节范围锁**：ACA/App Service 的 CIFS mount 选项由平台后端控制, **用户不能改**, 此路不通 (Microsoft 官方答复)
- **`PRAGMA journal_mode=wal` / `locking_mode=EXCLUSIVE`**: 已在 `hermes-8a599ed4` 容器内 probe 实证, 在 SMB 路径上**单连接零竞争**都失败, 切 PRAGMA 这一步本身就报锁错
- **任意 SQLite 客户端侧调参 (timeout、busy_handler、unix-dotfile VFS 等)**: 同上, 问题在"打开数据库时拿初始锁"这一步, 客户端怎么调都绕不开
- **让 hermes 把 session 存到非 SQLite 后端 (PG)**: 已查 hermes 源码 (`hermes_state.py`), `SessionDB` 直接 `sqlite3.connect()` 写死, 无 DSN/plugin 抽象。第三方 `elhenro/hermes-pg` 只替换 memory 不碰 session

#### 当前决策

**已执行方案 B (2026-06-03)**, 落地清单与执行记录见 [nfs.md](./nfs.md)。当时决策的理由:

1. 不止 hermes 一家踩 sqlite (上面 callout 已说), 只有切 NFS 是真根治
2. 真实成本 ~$16/月/用户 (dev 1 用户 = $16, 实际部署的 Provisioned v1 模型; 早期文档误以为 $3.2 是 v1 价, 实际是 v2 价, 已校正); 5+ 用户必须切 v2 见 [nfs.md §十](./nfs.md#十-未来优化-v1--v2-切换-todo-高优先级)
3. 平台当时无存量用户, destroy-recreate 无代价, 是切换的最佳窗口
4. 代码改动极小 (Bicep 加 VNet + Premium account, gateway `azure.ts` 改 50 行)

切换已于 2026-06-03 完成, 本节归入"已修复"类。

#### 排查命令速查

```bash
# 看实际错误
az monitor log-analytics query -w <workspace-customer-id> \
  --analytics-query "ContainerAppConsoleLogs_CL \
    | where ContainerAppName_s == 'hermes-<suffix>' \
    | where Log_s contains 'load_history' or Log_s contains 'database is locked' \
    | order by TimeGenerated desc | take 50"

# 进容器看 db 文件大小 (需要 pty, 用 script 包一层)
script -q /dev/null az containerapp exec -g rg-lingxi-dev -n hermes-<suffix> \
  --command "ls -la /home/hermes/.hermes/"
```
