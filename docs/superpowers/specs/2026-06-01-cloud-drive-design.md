# 云盘 (Cloud Drive) — 设计文档

**Spec 日期**: 2026-06-01
**分支**: `feat/cloud-drive`
**状态**: Draft, pending user review

## 一、概要

为 laifu 平台引入"云盘"能力，让 hermes agent 能够把执行产物**显式发布**到用户私有的云端文件库，用户在 web 仿桌面环境中通过一个 Finder 风格的"文件" App 浏览和下载这些文件。

云盘是一个**可订阅功能**（entitlement）：用户在"我的助理"设置里手动启用后，agent 才获得 `cloud_publish` 工具，桌面 Dock 才出现"文件" App。

### 核心定位

| 维度 | 决定 |
|---|---|
| 云盘性质 | laifu 自营文件库，每用户私有；不接外部网盘（如 OneDrive / 百度网盘） |
| 发布触发 | hermes agent 调用 `cloud_publish` CLI（显式动作，非自动同步） |
| 文件规模 | MVP ≤ 10MB 单文件 |
| 路径 | agent 显式传 `virtual_path`（如 `reports/2026-06/abc.pdf`） |
| Web 端能力 | MVP 浏览 + 下载 + PDF/图片预览（只读） |
| Web 形态 | 在仿 macOS 桌面里新增 "文件" App，仿 Finder 视图 |
| 计费 | MVP 免费即开通；走完整产品流程（启用按钮 + 等待状态），为未来付费留接口 |

### 不在 MVP 的（明确推迟）

- web 上传 / 删除 / 重命名 / 移动
- 全文搜索 / tag 筛选
- Markdown / 文本 / CSV 嵌入预览
- 配额限制
- 内容审计
- 文件版本 / 软删除 / 跨 region 灾备
- 客户端断点续传
- 真实计费 / 支付流程

---

## 二、总体架构

### 全图

```
[hermes container]                  [gateway / App Service]              [Web / Desktop]
 ┌──────────────────┐                ┌─────────────────────────┐          ┌─────────────┐
 │  agent           │  ① GET /sas    │  /api/cloud/sas         │          │  Files App  │
 │   cloud_publish ─┼───────────────►│  (JWT 验 → 签 SAS)      │          │  (Finder 仿)│
 │   tool           │                │                         │          │             │
 │   ┌────────────┐ │  ② SDK upload  │  /api/cloud/list        │◄─────────┼─ list       │
 │   │ SAS cache  │ │   (用 SAS)     │  (JWT 验 → list blobs)  │   JSON   │             │
 │   └────────────┘ │       ↓        │                         │          │             │
 └─────┬────────────┘       ↓        │  /api/cloud/download    │◄─────────┼─ click 文件 │
       │ JWT (env)          ↓        │  (JWT 验 → 签 read SAS  │  302 SAS │             │
       │                    ↓        │   → 302 重定向)         │          │             │
       │                    ↓        └─────────────────────────┘          └─────────────┘
       │                    ↓                                                     │
       │              ┌────────────────────────────────────────────┐              │
       │              │   Azure Blob Storage                       │              │
       │              │   container: laifu-cloud                   │◄─────────────┘
       │              │                                            │  浏览器拿 SAS 直连 GET
       │              │   <user_id>/<virtual_path>                 │
       │              │   + custom metadata (title/session/...)    │
       │              └────────────────────────────────────────────┘
```

### 设计要旨：控制平面 / 数据平面分离

- **控制平面** = gateway，负责：鉴权、签 SAS、列 metadata、entitlement 管理
- **数据平面** = Azure Blob，文件流不经 gateway
- **没有 cloud_files 表** —— Blob 自身的路径 + custom metadata 即事实层

### 新增 / 改动组件

| 组件 | 位置 | 新增/改 |
|---|---|---|
| `cloud_publish` Hermes skill | `docker/hermes/skills/cloud-publish/` | 新增 |
| gateway `/api/cloud/*` 路由 | `apps/gateway/src/api/cloud.ts` | 新增 |
| gateway `/api/entitlements/*` 路由 | `apps/gateway/src/api/entitlements.ts` | 新增 |
| 容器 JWT middleware | `apps/gateway/src/auth/container-token.ts` | 新增 |
| `user_entitlements` 表 + RLS | Supabase | 新增 |
| Azure Blob container `laifu-cloud` | Azure | 新增（一个 container，按 `<user_id>/` 前缀分用户） |
| `LAIFU_USER_TOKEN` 注入 | `apps/gateway/src/provisioning/{azure,local}.ts` | 改 |
| `/api/status` 扩展返回 entitlements | `apps/gateway/src/api/status.ts` | 改 |
| Files App | `apps/web/src/apps/files/` | 新增 |
| Dock + Desktop 注册 | `apps/web/src/desktop/{Dock,Desktop}.tsx` | 改 |
| ManageApp 启用 UI + 等待 Modal | `apps/web/src/apps/manage/ManageApp.tsx` | 改 |

### 不动的部分

- 现有 chat 流程（`/api/chat`、hermes 容器的 `/chat` `/history`）
- 微信 iLink polling、wechat 绑定流程
- 容器 → Azure Files 挂载 `/home/hermes`（云盘走 Blob，不复用 Files）
- hermes 容器的 `server.py`（uwf-hermes 集成调研里讨论的 FastAPI 重写**不在本 spec 范围**）

### 命名约定

- Storage account：`laifuprod`（prod）/ `laifu-dev`（dev）
- Blob container：`laifu-cloud`
- Blob 路径：`<user_id>/<virtual_path>`
- `user_id`：Supabase users 表的 UUID 主键
- 路径分隔符：`/`，agent 可传如 `reports/2026-06/abc.pdf`

---

## 三、数据模型

云盘**没有数据库表**（除 `user_entitlements`）。事实数据全部存在 Blob 自身。

### Blob 路径

```
storage account: laifuprod
container:       laifu-cloud
blob name:       <user_id>/<virtual_path>

例：
  6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f/reports/2026-06/sales.pdf
  6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f/charts/q2-revenue.png
```

### Blob Custom Metadata Schema

Azure Blob custom metadata 限制：总 ≤ 8KB，key 必须 ASCII，value 必须 ISO-8859-1（**不支持原生 UTF-8**）。

| key | 类型 | 编码 | 必/选 | 说明 |
|---|---|---|---|---|
| `title` | string | base64-utf8 | 必 | 用户可见的标题。CLI 缺省时 tool 用 virtual_path 的 basename 兜底。中文/emoji 先 base64，前端解码。 |
| `published_at` | string | ISO-8601 ASCII | 必 | 发布时间戳（容器时钟，tool 自动填）。冗余字段；以 blob 自身 `last_modified` 为权威 |
| `tool_version` | string | ASCII | 必 | publish tool 版本（如 `1.0.0`，tool 硬编码），便于排查 |
| `session_id` | string | ASCII | 选 | 发布时 hermes session id（`main` / `thr_xxx`）。CLI 不传时 tool 尝试从 env 拿，env 也无则不写此字段。 |
| `description` | string | base64-utf8 | 选 | 简短描述 |
| `tags` | string | base64-utf8（`,` 分隔） | 选 | tag 列表，预留筛选用 |

`Content-Type`、`Content-Length`、`Content-MD5` 走 Blob 自身的 HTTP 属性，不放 metadata。

### virtual_path 校验规则

校验工具放 `apps/gateway/src/lib/virtual-path.ts`，前端和 gateway 共享同一份实现（gateway 在 `/list` `/download` 时校验，前端在显示时校验避免脏数据）。

- 不允许 `..`、绝对路径开头 `/`、空段
- 单段长度 ≤ 200，总长 ≤ 1024
- 字符集 UTF-8；除 `/` 外不允许 `\` `\0` 等控制字符
- 大小写敏感（与 Blob 原生行为一致；Files App 显示时不做大小写合并）

### Entitlement 表

```sql
CREATE TABLE user_entitlements (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature     TEXT NOT NULL,              -- 'cloud', 未来 'wechat_pro' etc.
  enabled_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disabled_at TIMESTAMPTZ,                -- null 表示当前启用
  metadata    JSONB,                       -- 留扩展位（套餐版本号等）
  PRIMARY KEY (user_id, feature)
);

-- RLS: 用户只能读自己的
CREATE POLICY entitlements_own ON user_entitlements
  FOR SELECT USING (auth.uid() = user_id);
```

### 配额（MVP）

**不做配额**。先信任。未来需要时：
- gateway 签 SAS 时同步查 `list blobs` 累计大小，超阈值拒签
- 或后台 cron 周期统计写 Supabase（`user_quotas` 表），签 SAS 时查表

---

## 四、Entitlement 机制 — 云盘作为可订阅功能

### Entitlement 概念

**entitlement = 用户被授权能用哪些功能**。类比游戏的"已购 DLC 列表"。

数据库里就一行：`(user_id, feature='cloud')`。有这行 = 能用云盘；没这行 = 不能用。

### 启用云盘的完整流程

```
1. web ManageApp 用户点 [启用云盘]
        ↓ POST /api/entitlements/cloud/enable
2. gateway:
   INSERT user_entitlements (user_id, feature='cloud') ON CONFLICT DO NOTHING
        ↓
3. gateway 调 Azure SDK 重启该用户的 Container App (restartRevision)
        ↓
4. 容器启动，entrypoint.sh:
     a. 从 env 拿 LAIFU_USER_TOKEN (JWT)
     b. 调 gateway /api/me/entitlements?token=... 拉当前 entitlements
        → 返回 ["cloud"]
     c. 按 entitlements 软链对应 skill 到 hermes skill 目录：
        ln -snf /opt/hermes-skills/cloud_publish ~/.hermes/skills/cloud_publish
        ↓
5. hermes 启动，扫 ~/.hermes/skills/，加载 cloud_publish
        ↓
6. agent 现在能看到 cloud-publish CLI 这个工具
        ↓
7. web 端：等待 Modal 轮询 /api/status，看到 entitlements 含 'cloud'
   → 关闭 Modal，Dock 上 📁 Files 图标淡入，自动打开 Files App
```

停用流程对称：写 `disabled_at` → 重启 → entrypoint 软链不再创建。**不删除 Blob 数据**，下次重新启用看到原状。

### 容器侧 "启用 skill" 实现

镜像 Dockerfile 始终安装 cloud-publish 包到 `/opt/hermes-skills/cloud_publish/`，但 hermes 默认看不见（hermes 只扫 `~/.hermes/skills/`）。

entrypoint.sh 增量伪代码：

```bash
# === 拉 entitlements ===
ENTITLEMENTS_JSON=$(curl -fsS -m 10 \
  -H "Authorization: Bearer $LAIFU_USER_TOKEN" \
  "$GATEWAY_BASE_URL/api/me/entitlements")
ENTITLEMENTS=$(echo "$ENTITLEMENTS_JSON" | jq -r '.entitlements[]?' || echo "")

# === 按 entitlement 软链 skill ===
SKILL_DIR="$HOME/.hermes/skills"
mkdir -p "$SKILL_DIR"

# cloud_publish
if echo "$ENTITLEMENTS" | grep -qx "cloud"; then
  ln -snf /opt/hermes-skills/cloud_publish "$SKILL_DIR/cloud_publish"
else
  rm -f "$SKILL_DIR/cloud_publish"
fi

# 未来其他 feature 同样模式
# ...

exec "$@"
```

如果 entitlement 拉取失败：保留上次的软链状态（fail-safe），日志报错。

### 重启 vs 热 reload 的决策

**选自动重启（ACA restartRevision）。** 理由：
- 实现简单，无新端点
- 容器重启 5-15s，用户在等待 Modal 上能接受
- 启用云盘是低频操作（用户生命周期里通常 1 次）

热 reload（不重启 → admin 端点 + 信号 → hermes 重新扫 skills）复杂得多，省下的 5 秒不值。

### 容器到 gateway 的鉴权：JWT 设计

`LAIFU_USER_TOKEN` 是一个 **JWT, HS256**，由 gateway 签发，注入容器环境变量。

```
header:  { "alg": "HS256", "typ": "JWT" }
payload: { "user_id": "<uuid>", "iat": <epoch> }
         (无 exp 字段 - 不过期)
secret:  GATEWAY_SECRET (env)
```

容器调 gateway 时带 `Authorization: Bearer <jwt>`，gateway middleware 验签后注入 `req.user_id`。

**不带 exp 的理由**：容器可能 sleep 数天再被唤醒，短 TTL 会导致醒来第一个请求 401，用户体感"突然不能发布了"。

**应急轮换路径**（运维 runbook，写入 `docs/runbooks/gateway-secret-rotation.md`）：
1. gateway 同时支持 `GATEWAY_SECRET_OLD` + `GATEWAY_SECRET_NEW`，验签两个都试
2. 通过 provisioning 重启所有用户的容器，注入新 token
3. 24h 后下线 OLD

---

## 五、Gateway 侧 API

文件：`apps/gateway/src/api/cloud.ts` + `apps/gateway/src/api/entitlements.ts`

### 三组路由

```
─── 用户能力开通（web → gateway，session cookie 鉴权）────────────────
POST   /api/entitlements/cloud/enable     启用云盘
POST   /api/entitlements/cloud/disable    停用（保留 blob，仅取消 dock + skill）
GET    /api/status                        现有接口扩展 entitlements
GET    /api/me/entitlements               容器 entrypoint 拉自身权益（JWT 鉴权）

─── 云盘数据面（容器 → gateway，JWT 鉴权）─────────────────────────
GET    /api/cloud/sas                     拿写 SAS（限 <user_id>/ 前缀, 15min）

─── 云盘数据面（web → gateway，session cookie 鉴权）───────────────
GET    /api/cloud/list?prefix=...         列某虚拟目录下的文件夹和文件
GET    /api/cloud/download?path=...       签读 SAS，302 重定向给浏览器
```

### `POST /api/entitlements/cloud/enable`

```
auth: requireSession (web 用户)

逻辑:
  1. INSERT user_entitlements (user_id, feature='cloud') ON CONFLICT DO NOTHING
  2. 如果是首次开通 (INSERT 实际写入)：
       a. 调 Azure SDK restartRevision 重启该用户的 Container App
       b. 不等 health (不阻塞响应)；前端用 status poll 验证
  3. 返回 { ok: true, entitlements: [...] }

幂等: 已开通时直接返回当前 entitlements，不重启容器
```

### `GET /api/cloud/sas`

```
auth: container-token (容器内 JWT)

middleware:
  - 解 JWT 取 user_id
  - 查 user_entitlements 必须有 'cloud'，否则 403

逻辑:
  1. 拿 User Delegation Key (缓存 6 小时，跨请求复用)
  2. 用 DK 签 SAS:
     - 容器: laifu-cloud
     - 前缀: <user_id>/  ← 安全核心
     - 权限: racwl (read / add / create / write / list)
     - TTL: 15 分钟
     - protocol: https only
  3. 返回:
     {
       blob_endpoint: "https://laifuprod.blob.core.windows.net",
       container: "laifu-cloud",
       prefix: "<user_id>/",
       sas_token: "sv=...&sig=...",
       expires_at: "2026-06-01T12:15:00Z"
     }
```

### `GET /api/cloud/list?prefix=reports/`

```
auth: requireSession
middleware: 校验已开通 cloud

逻辑:
  1. full_prefix = `${user_id}/${prefix || ''}`
  2. listBlobsByHierarchy(container='laifu-cloud', prefix=full_prefix, delimiter='/')
  3. 拆分结果:
     folders: 子目录 (去掉 <user_id>/ 前缀)
     files: 每个 blob 的:
       - virtual_path (去掉 <user_id>/ 前缀)
       - size, last_modified, content_type
       - metadata: { title (b64 decoded), session_id, description (b64 decoded), tags (b64 decoded) }
  4. 返回 { folders, files }
```

### `GET /api/cloud/download?path=...`

```
auth: requireSession
middleware: 校验已开通 cloud

逻辑:
  1. 校验 path 合法 (不含 ..、不允许跨用户前缀)
  2. full_path = `${user_id}/${path}`
  3. blob HEAD 一次确认存在 (不存在 → 404)
  4. 签 read-only SAS (TTL 5 分钟，仅本 blob)
  5. 302 redirect 到 `${blob_endpoint}/${container}/${full_path}?${sas}`

浏览器直连 Blob 下载，不流过 gateway。
Content-Disposition 由 blob 的 content_type 决定 (图片/PDF 默认 inline 可预览，其他 attachment 下载)。
```

### 容器 JWT middleware：`apps/gateway/src/auth/container-token.ts`

```typescript
function containerToken(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({error: 'no token'});
  try {
    const payload = jwt.verify(auth.slice(7), GATEWAY_SECRET, { algorithms: ['HS256'] });
    req.user_id = payload.user_id;
    next();
  } catch (e) {
    return res.status(401).json({error: 'invalid token'});
  }
}
```

### User Delegation Key 缓存：`apps/gateway/src/lib/user-delegation-key-cache.ts`

签 SAS 每次都调 Azure 拿新 DK 会受限流。Gateway 缓存 DK（默认 7 天有效，缓存 6 小时）：

```typescript
class UserDelegationKeyCache {
  private cached?: { key: UserDelegationKey; expires: Date };

  async get(): Promise<UserDelegationKey> {
    if (this.cached && (this.cached.expires.getTime() - Date.now()) > 60 * 60 * 1000) {
      return this.cached.key;
    }
    return this.refresh();
  }

  private async refresh(): Promise<UserDelegationKey> {
    const start = new Date();
    const expiry = new Date(start.getTime() + 7 * 24 * 3600 * 1000);
    const key = await blobServiceClient.getUserDelegationKey(start, expiry);
    this.cached = { key, expires: expiry };
    return key;
  }
}
```

### 错误状态码

| 状态 | 含义 |
|---|---|
| 200 | OK |
| 302 | download 的重定向 |
| 400 | path 非法、SAS 范围越界 |
| 401 | JWT/session 无效 |
| 403 | entitlement 缺失 |
| 404 | blob 不存在 |
| 429 | (未来) 配额超 |
| 500 | gateway 内部错误 (DK 拿不到等) |

---

## 六、容器侧：`cloud_publish` Hermes Skill

### 形态

Hermes skill = "agent 可调用的命令行工具"。`cloud_publish` 是容器内一个 Python CLI（`cloud-publish` 命令），agent 通过 bash 调用：

```bash
cloud-publish --file <path> --virtual-path <path> --title "<标题>" [...选项]
```

同时提供 Hermes skill 描述（`skill.md`），让 hermes 加载时给 agent 看到"有这个工具能用"。

### 安装位置

- 源码：`docker/hermes/skills/cloud-publish/`
  - `setup.py` —— Python 包定义（entry_point: `cloud-publish = cloud_publish.__main__:main`）
  - `skill.md` —— Hermes skill 描述
  - `cloud_publish/__main__.py` —— CLI 入口
  - `cloud_publish/sas_cache.py` —— SAS 缓存读写
  - `cloud_publish/metadata.py` —— metadata 编码
  - `cloud_publish/uploader.py` —— Blob 上传逻辑
- Dockerfile 增加：`COPY` 到 `/opt/hermes-skills/cloud-publish/` + `pip install -e .` 装到镜像 venv
- 镜像始终带这个包；是否启用由 entrypoint 软链决定
- 依赖：`azure-storage-blob`（~2MB）

### CLI 接口

```
cloud-publish [options]

required:
  --file PATH              本地文件路径
  --virtual-path PATH      云盘上的虚拟路径，如 reports/2026-06/abc.pdf

optional:
  --title TEXT             可读标题，默认是 virtual-path 的 basename
  --description TEXT       描述
  --tags A,B,C             逗号分隔
  --session-id TEXT        关联的 hermes session（不传则从 env 拿当前 session）
  --content-type MIME      默认从文件扩展名推断 (Python mimetypes 库)

exit code:
  0  publish 成功，stdout: { "ok": true, "blob_name": "...", "url": "..." }
  1  入参错误 (file 不存在、virtual_path 非法、大小超限、metadata 超 8KB)
  2  鉴权失败 (JWT 过期 / GATEWAY_SECRET 换了 / entitlement 缺失)
  3  网络/上传失败 (重试 3 次后)
  4  其他错误

stdout 永远输出合法 JSON 一行，方便 agent 解析。
```

### SAS 缓存

文件：`~/.hermes/_cloud_sas.json`（落用户 volume，容器重启不丢）

```json
{
  "sas_token": "sv=2024-...&sig=...",
  "blob_endpoint": "https://laifuprod.blob.core.windows.net",
  "container": "laifu-cloud",
  "prefix": "6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f/",
  "expires_at": "2026-06-01T12:15:00Z"
}
```

加载策略：
1. 启动时读文件
2. 如果不存在 / 距 `expires_at < 60s` → 调 `GET gateway/api/cloud/sas` 拿新的，写回
3. 上传时一律带这个 SAS
4. SDK 上传返回 403（SAS 失效）→ 强制刷新 SAS 重试一次

### 上传逻辑（核心 Python 伪代码）

```python
def publish(file_path, virtual_path, title, description, tags, session_id):
    validate_local(file_path, virtual_path)   # 抛出 exit 1 错误
    sas = sas_cache.get_or_refresh()
    blob_name = f"{sas.prefix}{virtual_path}"
    client = BlobClient.from_blob_url(
        f"{sas.blob_endpoint}/{sas.container}/{blob_name}?{sas.sas_token}"
    )
    metadata = build_metadata(title, description, tags, session_id)  # base64 编码
    content_type = guess_content_type(file_path)
    with open(file_path, "rb") as f:
        try:
            client.upload_blob(
                f, overwrite=True, metadata=metadata,
                content_settings=ContentSettings(content_type=content_type)
            )
        except HttpResponseError as e:
            if e.status_code == 403:           # SAS 失效
                sas = sas_cache.force_refresh()
                # ... retry once
            raise
    return { "ok": True, "blob_name": blob_name }
```

### Skill 描述给 agent (skill.md)

```markdown
# cloud_publish

把容器内的一个文件发布到用户的云盘，用户在 web 端能看到并下载。

## 何时使用
当用户要求把"成果""产出""报告""图片"等保留下来 / 让 web 端可见时使用。
不是"保存到本地"，是发布到云端。

## 用法
\```
cloud-publish --file <path> --virtual-path <path> [--title "..."]
\```

## 注意
- virtual-path 决定 web 上的文件夹结构，按内容类型组织 (如 reports/, charts/, code/)
- 文件 ≤ 10MB
- 同 virtual-path 再次发布会覆盖
```

---

## 七、Web 侧：Files App + ManageApp 改动

### Files App

新增 `apps/web/src/apps/files/`:

```
files/
├── FilesApp.tsx          主体，窗口内容
├── FileList.tsx          中央文件列表 / 表格
├── Sidebar.tsx           左侧"位置"导航
├── PathBar.tsx           顶部面包屑
├── PreviewModal.tsx      PDF / 图片预览
├── api.ts                封装 /api/cloud/* 调用
├── types.ts              FolderItem / FileItem 等
└── utils.ts              扩展名 → icon / 大小格式化
```

### UI 大致样式

```
┌─────────────────────────────────────────────────────────────────┐
│  ◀  ▶    📁 reports / 2026-06                          🔄  ⊞ ☰  │  ← PathBar
├──────────────┬──────────────────────────────────────────────────┤
│              │  名称 ▲              修改时间      大小   类型    │
│  📁 我的云盘  ├──────────────────────────────────────────────────┤
│              │  📁 charts/                                       │
│  最近        │  📄 q2-sales.pdf      6月1日 12:30  856 KB  PDF   │
│  Tags（预留）│  📄 weekly-report.md  6月1日 11:15   12 KB  MD    │
│              │  🖼️ revenue-chart.png 5月30日 18:42 220 KB  PNG   │
└──────────────┴──────────────────────────────────────────────────┘
```

### 展示能力（MVP 全做）

| 项 | 说明 |
|---|---|
| 列表 / 图标视图切换 | 顶部 ⊞ / ☰ 按钮，state 记忆 |
| 排序 | 名称 / 大小 / 修改时间，升降序 |
| 文件详情浮层 | 点 ⋯ 看 title / description / tags / session_id / 完整路径，点 session_id 跳到 ChatApp 对应 thread |
| 空文件夹 | "还没有文件 · 让助理把成果发布到云盘" |
| 中文 / emoji 文件名 | base64 解码正确显示 |
| 按扩展名图标 | pdf / png / md / json / zip / ... 一组单色 SVG（或 emoji 兜底） |
| **PDF + 图片 嵌入预览** | 见下 |

### 预览（PDF + 图片，~70 行）

```
PreviewModal.tsx (~40 行)
  - 通用 modal 容器 + ESC / 点外部关闭 + 标题栏 (文件名 + 关闭 + 下载按钮)

预览分发 (~20 行)
  - .pdf → <iframe src={sas_url}> (浏览器原生 PDF viewer)
  - .png .jpg .jpeg .gif .webp → <img src={sas_url}>
  - 其他 → 不弹 modal，直接 window.open 走下载

集成到 FileList (~10 行)
  - 双击文件按扩展名分流
```

publish tool 上传时设对 `content-type`（Python `mimetypes` 推断），浏览器在 iframe/img/新 tab 里都能正确显示。

### 数据流（前端）

```typescript
// 状态
FilesApp:
  currentPath: string     // 相对路径，'' = 根
  folders: FolderItem[]
  files: FileItem[]
  loading: boolean
  error: string | null
  viewMode: 'list' | 'icon'
  sortBy: 'name' | 'size' | 'modified'
  sortDir: 'asc' | 'desc'

// 进入文件夹 / 初始加载
async function navigate(path: string) {
  setLoading(true);
  const data = await api.list(path);
  // 解 metadata 里的 base64 title/description/tags
  setFolders(data.folders);
  setFiles(data.files.map(decodeMetadata));
  setCurrentPath(path);
  setLoading(false);
}

// 点文件
function openFile(file: FileItem) {
  if (isPreviewable(file.contentType)) {
    setPreviewFile(file);  // 触发 PreviewModal
  } else {
    window.open(`/api/cloud/download?path=${encodeURIComponent(file.virtual_path)}`, '_blank');
  }
}
```

### ManageApp 改动

`apps/web/src/apps/manage/ManageApp.tsx` 增加"功能 / 订阅"分区：

```
┌────────────────────────────────────────────┐
│  我的助理                                  │
│                                            │
│  ╭─ 基本信息 ─────────╮                    │
│  │ 用户名: xxx        │                    │
│  │ 助理状态: ✓ 运行中 │                    │
│  ╰────────────────────╯                    │
│                                            │
│  ╭─ 功能 / 订阅 ──────────────────────╮    │
│  │  📩 微信      [ 绑定 / 已绑定 ]    │    │
│  │  ☁️  云盘     [ 启用 ]   ← 新增    │    │
│  │      启用后助理可发布文件 ...      │    │
│  ╰────────────────────────────────────╯    │
└────────────────────────────────────────────┘
```

### 启用云盘 — 显式等待 UI

```
点 [启用] →
  打开 Modal (不可关闭):

  ┌─────────────────────────────────────────┐
  │       ☁️  正在启用云盘                  │
  │                                         │
  │   [▓▓▓▓░░░░░░░] 助理重启中...           │
  │                                         │
  │   预计 5 - 15 秒                        │
  └─────────────────────────────────────────┘

逻辑:
  step 1: POST /api/entitlements/cloud/enable → 200 表示 DB 已写
          ("正在记录权益...")
  step 2: 轮询 GET /api/status 每 2s 一次
          直到 containerStatus === 'running' && entitlements.includes('cloud')
          最长 30s
          ("助理重启中...")
  step 3: 成功 → 关闭 Modal，Dock 上 Files 图标淡入，并自动打开 Files App
          ("✓ 已启用")
  step 4: 失败 / 超时 → Modal 转错误态:
          "启用未完成，请稍后在'我的助理'重试"
          [关闭] [立即重试]
```

依赖 `/api/status` 反映容器是否已按新 entitlement 重启完。最简实现：复用现有 status 的 container health 检查 + 增加 entitlements 字段。

### Desktop / Dock 改动

```typescript
// Desktop.tsx
- openApps 类型加 'files'
- titles 加 { title: '文件', icon: <IconFolder/>, w: 900, h: 600 }
- renderApp 加 if (id === 'files') return <FilesApp />

// Dock.tsx
- props 加 entitlements: string[]
- 基础 app (chat, manage) 始终显示
- 条件 app: if (entitlements.includes('cloud')) 渲染 Files 图标
```

entitlements 传到 Desktop 的方式：
- Desktop 调 `api.status()` 时拿到 entitlements
- ManageApp 启用成功后通过 callback / Context 通知 Desktop 重拉 status

### 不在 MVP

- 上传 / 删除 / 改名 / 移动
- 搜索 / 筛选 tag
- MD / 文本 / CSV 嵌入预览
- 拖拽 / 多选 / 右键菜单

---

## 八、错误处理 + 边界

### 多租户安全（最关键）

| 攻击场景 | 防线 |
|---|---|
| agent 在 virtual_path 塞 `../../<别人 uuid>/...` | 1) SAS 严格限定 `<user_id>/` 前缀，Azure 服务端会拒；2) gateway 在 `/list` `/download` 二次校验 path 不含 `..` 不含 `/` 开头 |
| 容器拿到 JWT 后伪造 user_id | JWT 用 `GATEWAY_SECRET` 签 + verify；不知 secret 改不动 payload |
| web 用户改 `download?path=` 想下别人的文件 | gateway 在 session middleware 已经拿到 user_id；path 跟 user_id 拼接成 blob name，不可能跨 |
| SAS 泄露 | 限定到单用户前缀 + 15min 过期，横向影响 0 |
| GATEWAY_SECRET 泄露（平台事故） | 走应急轮换 runbook：换 secret → 批量重启容器（重发 JWT） |

### 容器侧错误处理（`cloud-publish` CLI）

| 错误 | exit | stdout | 重试 |
|---|---|---|---|
| 文件不存在 | 1 | `{"ok":false,"error":"file not found"}` | 不重试 |
| 文件 > 10MB | 1 | `{"ok":false,"error":"file too large (12.3 MB)"}` | 不重试 |
| virtual_path 非法 | 1 | `{"ok":false,"error":"invalid virtual path"}` | 不重试 |
| metadata 总长 > 8KB | 1 | `{"ok":false,"error":"metadata too large"}` | 不重试 |
| gateway 5xx 拿 SAS 失败 | 3 | `{"ok":false,"error":"sas fetch failed"}` | 指数退避 3 次 |
| JWT 鉴权 401 | 2 | `{"ok":false,"error":"auth failed"}` | 不重试（容器需重启换 token） |
| Entitlement 缺失 403 | 2 | `{"ok":false,"error":"cloud not enabled"}` | 不重试 |
| SAS 上传 403（过期） | 0 → 重试 → 成功 | 正常 | 刷 SAS 重试一次 |
| SAS 上传 5xx | 3 | `{"ok":false,"error":"upload failed"}` | 指数退避 3 次 |
| 网络超时 | 3 | `{"ok":false,"error":"timeout"}` | 重试 3 次 |

### Gateway 错误处理

| 端点 | 错误场景 | 行为 |
|---|---|---|
| `/api/cloud/sas` | DK 缓存失效拿不到新 key | 500，记 error log；前端轮询重试 |
| `/api/cloud/list` | Blob storage 502 | 502 透传 + 错误码，前端显示"暂时不可用" |
| `/api/cloud/download` | Blob 不存在 | 404 |
| `/api/cloud/download` | path 含 `..` 或绝对路径 | 400 |
| `/api/entitlements/cloud/enable` | DB 写成功但 ACA restart 调用失败 | 200 返回 entitlements 但带 warning；前端 poll status 时会发现没 ready，给用户错误 modal + "重试"按钮 |
| `/api/entitlements/cloud/enable` | 容器 health 60s 内没起来 | DB 已写，给运维一个手动恢复入口（admin 重启） |

### Web 错误处理

- Files App 加载失败 → 文件列表区显示"加载失败"+ 重试按钮（不全屏炸）
- 预览加载失败（PDF 损坏、SAS 超时）→ 预览 modal 显示"预览失败 · [下载]"
- 启用云盘 modal 超时 30s → 转错误态："启用未完成，请稍后在'我的助理'重试"，附 [关闭] 和 [立即重试]
- entitlement disable 后 Files App 仍打开 → 下次 list 401，前端检测后关 app 并 toast 提示

### 边界条件

| 情况 | 行为 |
|---|---|
| 同 virtual_path 重复 publish | blob `overwrite=true`，覆盖，`last_modified` 更新；web 列表自动反映 |
| 停用 cloud 后 blob 怎么办 | 保留所有 blob，下次重新开通看到原数据；只是 Dock 隐藏 + skill 软链删除 |
| 容器睡了再醒，SAS 缓存早过期 | SAS cache 加载时见到 `expires_at < now` → 自动刷一次再用 |
| 同 user 多个 publish 并发 | 不同 blob name 互不影响；同 name 并发以 Azure 服务端最后一次为准 |
| 空文件 | 允许，0 字节 blob 合法 |
| 巨型 virtual_path 深嵌套 | 单段 ≤ 200 / 总 ≤ 1024 字符；超限 client 校验拒绝 |
| Blob 上传中容器被 ACA kill | publish 进程被杀；Azure 自动判定不完整 PUT 会失败，最终没有这个 blob，下次发布重传 |
| 容器没开通 cloud 但 agent 试图调 cloud-publish | CLI 文件不在路径中，bash 报 command not found；agent 自己处理 |
| 用户删账号 | `user_entitlements` 通过 ON DELETE CASCADE 一起删；blob 怎么清放后续运维 spec |

### 不在 MVP 处理（明确忽略）

| 项 | 理由 |
|---|---|
| 配额超限 | MVP 信任，不做配额；超大用户出现再加 |
| 内容审计（敏感词等） | MVP 不做；只走 platform-level 合规 |
| 跨 region 灾备 / blob 软删除 / 版本号 | 起步阶段单 region；后期再加 soft delete + versioning |
| Rate limiting | 起步 ≤ 50 用户没必要 |
| 客户端断点续传 | ≤ 10MB 没必要 |

---

## 九、测试策略

### 测试金字塔

```
              ┌───────────────────────┐
              │   手动 E2E (4 个场景)  │
              └───────────┬───────────┘
                          │
              ┌───────────┴───────────┐
              │  集成测试 (~6 个)      │
              │  vitest + local stack  │
              └───────────┬───────────┘
                          │
              ┌───────────┴───────────┐
              │  单元测试 (~25 个)     │
              │  各模块独立            │
              └───────────────────────┘
```

### 单元测试

**Gateway 侧（vitest，独立 `apps/gateway/test/` 目录，按子模块镜像 src）**

| 模块 | 关键用例 |
|---|---|
| `test/auth/container-token.test.ts` | 1) 有效 JWT 解出正确 user_id 2) 过期/篡改的 JWT 401 3) 缺 Authorization header 401 |
| `test/api/cloud.test.ts` `/sas` | 1) entitlement 存在 → 返回 SAS（mock User Delegation Key）2) entitlement 缺 → 403 3) DK 服务异常 → 500 |
| `test/api/cloud.test.ts` `/list` | 1) prefix=空 列根目录 2) prefix=`reports/` 列子目录 3) 跨用户前缀越界 → 400 4) metadata base64 字段解码正确 |
| `test/api/cloud.test.ts` `/download` | 1) 正常签出 SAS + 302 2) blob 不存在 → 404 3) path 含 `..` → 400 |
| `test/api/entitlements.test.ts` | 1) enable 写表幂等 2) enable 触发容器 restart (mock provisioner) 3) disable 不删 blob |
| `test/lib/virtual-path.test.ts` | 路径校验：合法 / `..` / 绝对路径 / 超长 / 空段 / 控制字符 |
| `test/lib/user-delegation-key-cache.test.ts` | 1) 首次拿 → 调 Azure 2) 缓存内 → 不调 3) 过期 → 刷新 |

**容器侧（pytest，`docker/hermes/skills/cloud-publish/tests/`）**

| 模块 | 关键用例 |
|---|---|
| `test_sas_cache.py` | 1) 文件不存在 → 调 gateway 2) 文件存在且未过期 → 直接用 3) 即将过期（<60s）→ 刷新 4) 文件损坏 → 重拉 |
| `test_metadata.py` | 1) 中文 title base64 后符合 ASCII 2) 总长 > 8KB 报错 3) 缺省字段不写 metadata |
| `test_uploader.py` | 1) 正常上传 2) 403 SAS 失效 → 刷新重试一次 3) 5xx 指数退避 3 次 |
| `test_main.py` | 1) 入参校验：file 不存在 / 路径非法 / 超限 2) stdout 是合法 JSON 3) exit code 正确 |

**Web 侧（vitest + @testing-library/react，独立 `apps/web/test/` 目录）**

| 模块 | 关键用例 |
|---|---|
| `test/files.api.test.ts` | 1) list 解码 metadata 2) download 触发 window.open 3) 错误响应正确抛出 |
| `test/FilesApp.test.tsx` | 1) 初始加载 list 2) 路径导航 3) 错误显示 |
| `test/FileList.test.tsx` | 1) 文件/文件夹分行渲染 2) 双击文件夹 navigate 3) 双击文件预览或下载 4) 排序切换 |
| `test/PreviewModal.test.tsx` | 1) PDF 触发 iframe 2) png 触发 img 3) 其他类型不显示 modal 4) ESC 关闭 |
| `test/Dock.test.tsx` | 1) entitlements 含 cloud → Files 图标显示 2) 不含 → 隐藏 |
| `test/ManageApp.entitlements.test.tsx` | 1) 点启用调 API 2) 加载 Modal 状态机：写表 → poll → 成功/失败 |

注：当前 `apps/gateway/src/api/healthz.test.ts` 跟约定不一致（src 内同居），是历史遗留。本 spec **不模仿**，新增测试一律放 `test/` 目录。

### 集成测试

用现有的 `provisioning/local.ts` + Azure Storage Emulator (Azurite) 跑端到端，无需真 Azure：

| Test | 描述 |
|---|---|
| 1. 端到端 publish + list + download | mock publish CLI → gateway 真路由（local provisioner + Azurite）→ 验证 sha256 |
| 2. entitlement enable 流程 | enable API → 验证 DB 写入 + provisioner mock 被调用 restart → status 反映 entitlements 含 cloud |
| 3. 多租户隔离 | 两个 user 各自 publish 同名 virtual_path → 验证 list 时只看到自己的，user A 试图 download user B 的 path → 404 |
| 4. SAS 刷新 | 容器侧 sas_cache 模拟"快过期"→ 验证再 publish 时自动刷新 |
| 5. virtual_path 注入防御 | 容器侧 publish `../<另一 user>/x.txt`→ 验证 Azure 服务端拒（403）或 gateway 拒（400） |
| 6. disable 后 list/sas 都 403 | 启用后停用，验证容器 sas 拿不到，web list 也 403 |

### 手测清单（pre-launch）

1. **完整产品流程**：注册新用户 → 容器起 → ManageApp 启用云盘 → 看到等待 modal → 5-15s 后 Dock 出现 Files → 进 ChatApp 让 agent 发布一个 PDF → 切到 Files App 看到 → 双击预览
2. **图片预览**：让 agent 发个 PNG 截图，Files 双击在 modal 内能看
3. **中文文件名**：发布"销售报告.pdf" → 列表显示中文 → 下载文件名也是中文
4. **停用恢复**：停用 cloud → Files 图标消失 → 重新启用 → blob 还在

### 不在 MVP 测的

- 性能 / 压力测试（用户少）
- 安全渗透测试（依赖 Azure RBAC + JWT 库已知安全性）
- 跨浏览器兼容（先只保 Chrome / Edge / Safari）

---

## 十、分阶段实施

每个 Phase 独立可验证、独立可 merge。

| Phase | 标题 | 交付物 | 验证标准 |
|---|---|---|---|
| **P0** | 基建准备 | Azure storage account + container `laifu-cloud` 创建；`GATEWAY_SECRET` env；user delegation key cache 类骨架 | gateway 启动不报错；手动测能签 SAS |
| **P1** | Entitlement 机制 | Supabase 表 + RLS；`/api/entitlements/cloud/enable\|disable`；`/api/status` 扩展返回 entitlements；容器 entrypoint 软链逻辑 + `LAIFU_USER_TOKEN` 注入；gateway 触发 ACA restart | 单测 + 一个 local 集成测试：调 enable → status 反映 → 容器 restart 一次 |
| **P2** | Cloud 数据面 gateway | `/api/cloud/sas` `/list` `/download`；container-token middleware；virtual-path 校验 lib | 单测 + 集成测试（test 3 多租户隔离 + test 5 注入防御） |
| **P3** | 容器侧 publish CLI | `docker/hermes/skills/cloud-publish/` Python 包；SAS cache；skill.md；Dockerfile + entrypoint 改 | 容器内 `cloud-publish` 实际打通到 Azurite；单测覆盖 sas_cache 和 metadata 编码 |
| **P4** | Files App MVP（浏览+下载） | `apps/web/src/apps/files/`：列表视图、面包屑、双击下载、空状态、文件图标 | 端到端：agent 发布 → web 浏览 → 下载文件 sha256 匹配 |
| **P5** | ManageApp 启用流程 | 启用按钮 + 等待 Modal + poll status；Dock 动态显示 Files | 端到端：UI 点启用 → modal → 5-15s → Dock 现 Files |
| **P6** | Files App 展示完善 | 图标视图切换、排序、详情浮层、PDF/图片预览 modal | 手测 4 个场景 |
| **P7** | 上线收尾 | 文档、监控、运维 runbook（GATEWAY_SECRET 轮换） | 灰度一个用户验证完整流程 |

每个 Phase 估 1-3 天。整体估 12-15 天工作量（含测试与 PR review）。

### 文件 Footprint

```
新增 — gateway 源码:
  apps/gateway/src/api/cloud.ts                            (~250 行)
  apps/gateway/src/api/entitlements.ts                     (~120 行)
  apps/gateway/src/auth/container-token.ts                 (~50 行)
  apps/gateway/src/lib/virtual-path.ts                     (~80 行)
  apps/gateway/src/lib/user-delegation-key-cache.ts        (~70 行)
  apps/gateway/src/db/entitlements-dao.ts                  (~80 行)

新增 — gateway 测试 (独立 test/ 目录):
  apps/gateway/test/api/cloud.test.ts                      (~200 行)
  apps/gateway/test/api/entitlements.test.ts               (~100 行)
  apps/gateway/test/auth/container-token.test.ts           (~80 行)
  apps/gateway/test/lib/virtual-path.test.ts               (~60 行)
  apps/gateway/test/lib/user-delegation-key-cache.test.ts  (~80 行)

新增 — web 源码:
  apps/web/src/apps/files/FilesApp.tsx                     (~120 行)
  apps/web/src/apps/files/FileList.tsx                     (~150 行)
  apps/web/src/apps/files/Sidebar.tsx                      (~50 行)
  apps/web/src/apps/files/PathBar.tsx                      (~60 行)
  apps/web/src/apps/files/PreviewModal.tsx                 (~70 行)
  apps/web/src/apps/files/api.ts                           (~80 行)
  apps/web/src/apps/files/types.ts                         (~40 行)
  apps/web/src/apps/files/utils.ts                         (~50 行)

新增 — web 测试 (独立 test/ 目录):
  apps/web/test/files.api.test.ts                          (~50 行)
  apps/web/test/FilesApp.test.tsx                          (~80 行)
  apps/web/test/FileList.test.tsx                          (~80 行)
  apps/web/test/PreviewModal.test.tsx                      (~50 行)
  apps/web/test/Dock.test.tsx                              (~40 行)
  apps/web/test/ManageApp.entitlements.test.tsx            (~50 行)

新增 — 容器侧 (skill 包，tests/ 跟 cloud_publish/ 平级):
  docker/hermes/skills/cloud-publish/setup.py                       (~30 行)
  docker/hermes/skills/cloud-publish/skill.md                       (~50 行)
  docker/hermes/skills/cloud-publish/cloud_publish/__main__.py      (~150 行)
  docker/hermes/skills/cloud-publish/cloud_publish/sas_cache.py     (~80 行)
  docker/hermes/skills/cloud-publish/cloud_publish/metadata.py      (~60 行)
  docker/hermes/skills/cloud-publish/cloud_publish/uploader.py      (~120 行)
  docker/hermes/skills/cloud-publish/tests/test_sas_cache.py        (~80 行)
  docker/hermes/skills/cloud-publish/tests/test_metadata.py         (~60 行)
  docker/hermes/skills/cloud-publish/tests/test_uploader.py         (~100 行)
  docker/hermes/skills/cloud-publish/tests/test_main.py             (~80 行)

新增 — 基础设施 / 文档:
  supabase/migrations/<timestamp>_create_user_entitlements.sql
  infra/azure/storage-blob.tf  (或手动文档 README)         (~50 行)
  docs/runbooks/gateway-secret-rotation.md                 (~80 行)

改:
  apps/gateway/src/index.ts                                (+~5 行 注册路由)
  apps/gateway/src/api/status.ts                           (+~20 行 加 entitlements)
  apps/gateway/src/config.ts                               (+~15 行 加 storage / secret env)
  apps/gateway/src/provisioning/azure.ts                   (+~30 行 注入 LAIFU_USER_TOKEN, restart action)
  apps/gateway/src/provisioning/local.ts                   (+~20 行 同上)
  apps/gateway/package.json                                (+ @azure/storage-blob + jsonwebtoken)

  apps/web/src/desktop/Desktop.tsx                         (+~15 行 加 files app)
  apps/web/src/desktop/Dock.tsx                            (+~20 行 按 entitlements 渲染)
  apps/web/src/apps/manage/ManageApp.tsx                   (+~80 行 加 entitlements 区 + Modal)
  apps/web/src/lib/api.ts                                  (+~40 行 加 cloud / entitlements API)
  apps/web/src/lib/icons.tsx                               (+~30 行 文件类型图标)

  docker/hermes/Dockerfile                                 (+~10 行 COPY skills + pip install)
  docker/hermes/entrypoint.sh                              (+~30 行 拉 entitlements + 软链 skills + JWT 读取)

总估: ~2700 行新增源码, ~1190 行测试, ~315 行改, ~200 行配置/文档/migration
```

---

## 十一、风险与未决项

| 项 | 风险 | 缓解 |
|---|---|---|
| Hermes 的 skill 注册机制具体怎么走 | 没读 hermes 源码，可能要 PR upstream | P3 开始前先花 0.5 天读 `/opt/hermes-agent/` skill 加载源码，决定 `~/.hermes/skills/` 软链是否可行，必要时改 hermes config |
| ACA `restartRevision` API 行为 | 可能有限流或延迟 | P1 开发时实测一次；必要时换成 `deleteRevision` + 等 auto-redeploy |
| Azurite 对 User Delegation SAS 的支持 | 历史上支持不全 | 集成测试若发现 Azurite 不支持，fallback 用 service SAS 在测试里跑；prod 仍走 UDK |
| `~/.hermes/skills/` 跨容器版本 hermes 接口稳定性 | 上游变接口风险 | 在 skill.md 里 pin 一个 protocol version |
| `/api/me/entitlements` 是新增的，跟现有 `/api/me/*` 命名空间合并还是单开 | 命名一致性 | P1 决定（看现有 me 路由结构） |

### Open Questions（实施时决定）

- entitlement disable 后 blob 是否要后台清理？MVP 保留；引入清理 cron 时另写 spec
- 多用户共用一个 storage account 的 throttling 限制需不需要 sharding？规模到 1000+ 用户时再评估
- 未来开通付费时 entitlement metadata jsonb 字段需要哪些字段？暂留空，付费 spec 时定

---

## 十二、相关文档

- 平台整体架构：`docs/superpowers/specs/architecture-overview.md`
- MVP spec：`docs/superpowers/specs/2026-05-30-lingxi-mvp-spec.md`
- uwf × hermes 集成调研（暂停，与本 spec 无关）：`docs/superpowers/investigations/2026-06-01-uwf-hermes-integration.md`

