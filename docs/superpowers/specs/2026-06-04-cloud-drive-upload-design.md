# 云盘反向功能设计：web 上传 → agent 下载

**日期**: 2026-06-04
**分支**: feat/cloud-drive-upload
**状态**: Draft, pending user review
**关联**: 续 [2026-06-01-cloud-drive-design.md](./2026-06-01-cloud-drive-design.md)（agent 发布 → web 浏览）

## 一、概要

现有云盘是单向的：hermes agent 通过 `cloud-publish` 把成果发布到用户私有云盘，用户在 web "文件" App 浏览/下载（只读）。本设计补齐**反向方向**：

- 用户在 web "文件" App **上传**文件到云盘；
- hermes agent 通过新的 `cloud-download` CLI **列出并下载**云盘文件来使用。

借此，用户可以把素材（数据集、图片、文档）放进云盘交给 agent 处理，形成"web ⇄ agent"双向闭环。

### 核心决策

| 维度 | 决定 | 理由 |
|---|---|---|
| 上传传输路径 | **gateway 代理**（浏览器 → multipart → gateway → Blob） | 控制点集中：服务端强制大小、写 `source` 标记、校验路径；浏览器永不接触写 SAS |
| agent 下载机制 | **复用现有 `/api/cloud/sas`**（目录 SAS 权限为 `racwl`，已含 read+list）+ 新 `cloud-download` CLI 直连 Blob | 零新增 gateway 数据面端点，认证模型完全复用 |
| 上传 UX | `[上传]` 按钮 + 拖拽到当前文件夹，多文件并发，独立进度 | 对齐主流云盘 |
| 文件大小上限 | ≤ 10MB（与 agent 发布一致） | 统一；前端拦 + 服务端二次校验 |
| 同名冲突 | 上传前比对当前文件夹，**汇总一次确认**：`[全部覆盖] [跳过已存在] [取消]` | 多文件不逐个打断 |
| 来源标记 | Blob metadata `source = web \| agent`，列表加小角标区分 | 让用户/agent 区分"我上传的"与"agent 产出的" |
| 下载交互 | 单击选中（Cmd/Ctrl 多选、Shift 范围）、双击预览、选中后顶部工具栏 `[预览][下载]` | 双击不再触发下载，对齐主流云盘 |
| 批量下载 | 前端**逐个触发** `window.open(download?dispose=attachment)` | 复用现有端点，MVP 最轻 |

### 不在本期的（沿用原 MVP 推迟项）

- 删除 / 重命名 / 移动
- 文件夹整体上传、拖拽目录
- 全文搜索 / tag 筛选 / 配额
- gateway 打包 zip 批量下载（批量下载先用逐个触发）
- 分块 / 断点续传
- 上传审计表（来源等元数据存 Blob metadata，不落库）

---

## 二、总体架构

```
[hermes container]                [gateway / App Service]            [Web / Desktop]
 ┌─────────────────┐              ┌──────────────────────────┐       ┌──────────────┐
 │ agent           │              │  已有:                    │       │  Files App   │
 │  cloud-publish ─┼──① GET /sas─►│  /api/cloud/sas (racwl)  │       │              │
 │  cloud-download─┼──② 列出/下载─►│  /api/cloud/list (+source)│◄─列出─┤  list        │
 │   (新)          │   (复用 SAS) │  /api/cloud/download     │◄─下载─┤  选中→[下载]  │
 │  ┌───────────┐  │   直连 Blob  │                          │◄─预览─┤  双击→预览    │
 │  │ SAS cache │  │              │  新增:                    │       │              │
 │  └───────────┘  │              │  POST /api/cloud/upload  │◄─上传─┤ [上传]/拖拽   │
 └─────────────────┘              │  (session验→写Blob→      │ multi │  覆盖汇总确认  │
                                  │   metadata.source=web)   │ part  └──────────────┘
                                  └──────────────────────────┘
   Azure Blob: <user_id>/<virtual_path>   (metadata.source = web | agent)
```

新增物只有三处，其余全部复用既有设施：
1. **gateway** 一个 `POST /api/cloud/upload` 端点（含 multipart 解析）；
2. **agent** 一个 `cloud-download` CLI（与 `cloud-publish` 同 skill 包）；
3. **web** 上传 UI + 下载交互改版 + 轻量预览 modal。

---

## 三、数据流

### 3.1 Web 上传（gateway 代理）

1. 用户在当前文件夹（`currentPath`）点 `[上传]` 选文件，或把文件拖入文件列表区域。
2. 前端对每个文件计算 `virtual_path = currentPath + 文件名`，并按已加载的 `files` 列表**比对同名**：
   - 有冲突 → 弹**汇总确认** modal：列出冲突文件名 + `[全部覆盖] [跳过已存在] [取消]`；
   - 无冲突 → 直接进入上传。
3. 按决策得到待上传队列，**并发上传（上限 3）**，每个文件一条进度。
4. 每个文件 `POST /api/cloud/upload`（`multipart/form-data`：`file` + `virtual_path` + 可选 `title`）。
5. gateway（session 认证 + `cloud` entitlement 中间件）：
   - 校验 `virtual_path`（`validateVirtualPath`：无 `..`、非绝对、段 ≤200、总 ≤1024）；
   - 校验 size ≤ 10MB（服务端二次，超出 413）；
   - 用既有 `blobServiceClient` 写 Blob `<user_id>/<virtual_path>`，`overwrite=true`；
   - 写 metadata：`title`(b64-utf8)、`published_at`(ISO)、`tool_version`、`source='web'`、`content_type`（取上传 MIME，缺省按扩展名猜）。
6. 返回 `{ok:true, virtual_path, size, last_modified}`。
7. 队列全部结束后前端刷新当前文件夹 list；失败项在进度列表里标红，可单独重试。

### 3.2 Agent 下载（复用 racwl 目录 SAS，不经 gateway 数据面）

1. `cloud-download --list [--prefix reports/]`
   - 读 `~/.hermes/_cloud_sas.json`（复用 `sas_cache.get()`，过期则向 `/api/cloud/sas` 刷新）；
   - 用 `blob_endpoint + container + sas_token` 构造 `ContainerClient`，`list_blobs(name_starts_with=<sas_prefix> + 用户 --prefix)`（**扁平递归**列出前缀下所有文件，对 agent 最实用）；
   - 去掉 `<user_id>/` 前缀还原成 `virtual_path`，解码每个 blob 的 metadata（b64 → utf8），输出 JSON：`{files:[{virtual_path, size, last_modified, content_type, source, title}]}`。
2. `cloud-download --virtual-path reports/data.csv --output /home/hermes/work/data.csv`
   - 同一 SAS 构造 `BlobClient`，`download_blob()` 流式写本地 `--output`；
   - 输出 JSON：`{ok:true, virtual_path, output, size, sha256?}`。
3. 复用 publish 的健壮性：403（SAS 失效）→ 强制刷新 SAS 重试一次；5xx → 指数退避 3 次。

> 关键依据：现有 `/api/cloud/sas` 签发的目录 SAS 权限是 `racwl`（`apps/gateway/src/lib/sas-builder.ts:27`），已含 **read + list**，agent 下载无需任何新 gateway 端点。

---

## 四、API 契约

### `POST /api/cloud/upload` （新增）

| 项 | 说明 |
|---|---|
| 认证 | session cookie（web）+ `cloud` entitlement 中间件（复用 `/list`、`/download` 同款） |
| Content-Type | `multipart/form-data` |
| 字段 | `file`（二进制，必填）、`virtual_path`（string，必填）、`title`（string，可选，缺省取文件名） |
| 解析 | Express + `multer`（`memoryStorage`，`limits.fileSize = 10*1024*1024`） |
| 成功 | `200 {ok:true, virtual_path, size, last_modified}` |
| 错误 | `400` path 非法 / `401` 未登录 / `403` 未启用 cloud / `413` 超过 10MB / `500` 写 Blob 失败 |

写 Blob 伪代码：

```ts
const blobName = `${userId}/${virtualPath}`;
await blobServiceClient
  .getContainerClient(container)
  .getBlockBlobClient(blobName)
  .uploadData(buffer, {
    blobHTTPHeaders: { blobContentType: contentType },
    metadata: {
      title: b64(title),
      published_at: nowIso,
      tool_version: '0.1.0',
      source: 'web',
    },
  }); // uploadData 默认覆盖同名
```

### `GET /api/cloud/list` （改动）

- 返回的每个 file 的 `metadata` 增加 `source` 字段（ASCII，`'web' | 'agent'`，不做 b64）；
- 旧文件无 `source` metadata → 缺省视为 `'agent'`（向后兼容）。

### `cloud-download` CLI 契约

```
cloud-download --list [--prefix <虚拟前缀>]   # 扁平递归列出前缀下所有文件
cloud-download --virtual-path <路径> --output <本地文件>

环境变量（与 cloud-publish 一致）：GATEWAY_BASE_URL, LAIFU_USER_TOKEN[, LAIFU_SESSION_ID]
退出码：0 成功 / 1 入参错误 / 2 鉴权失败 / 3 网络或下载失败 / 4 其他
输出：stdout 一行 JSON
```

---

## 五、组件改动清单

| 层 | 文件 | 改动 |
|---|---|---|
| Gateway | `apps/gateway/src/api/cloud.ts` | 新增 `POST /api/cloud/upload`；`/list` 透传 `source`；引入 multer 中间件 |
| Gateway | `apps/gateway/package.json` | 加依赖 `multer`（+ 类型） |
| Agent CLI | `docker/hermes/skills/cloud/cloud_publish/metadata.py` | publish metadata 增加 `source='agent'` |
| Agent CLI | `docker/hermes/skills/cloud/cloud_publish/downloader.py` | **新增**：list + download（复用 `sas_cache`） |
| Agent CLI | `docker/hermes/skills/cloud/cloud_publish/__main__.py` 或新模块 | **新增** `cloud-download` 入口 |
| Agent CLI | `docker/hermes/skills/cloud/setup.py` | 加 entry point `cloud-download=...` |
| Agent CLI | `docker/hermes/skills/cloud/SKILL.md` | 补充 `cloud-download` 用法、何时用（"用户上传了文件让我处理"） |
| Agent 运行时 | entrypoint symlink | download 与 publish 同一 skill 目录，`cloud` 启用时一并带上，**无需改 symlink 逻辑** |
| Web 上传 | `apps/web/src/apps/files/UploadButton.tsx`（新）+ `DropZone`（新或并入 FilesApp） | `[上传]` 按钮 + 拖拽 zone（dragover 高亮）+ 并发队列 + 进度 + 冲突汇总 modal |
| Web 上传 | `apps/web/src/lib/api.ts` | 新增 `cloudUpload(file, virtualPath, {onProgress})`，用 `XMLHttpRequest` 取上传进度 |
| Web 下载交互 | `apps/web/src/apps/files/FilesApp.tsx` | 维护 `selected: Set<string>`；单击/Cmd/Shift 选中逻辑；双击分流 |
| Web 下载交互 | `apps/web/src/apps/files/FileList.tsx` | 行选中高亮、双击预览/进文件夹 |
| Web 下载交互 | `apps/web/src/apps/files/PathBar.tsx` | 选中后出现 `[预览][下载]`（预览仅单选且可预览类型可用；下载逐个触发） |
| Web 预览 | `apps/web/src/apps/files/Preview.tsx`（新） | 轻量 modal：PDF→`<iframe src=download?dispose=inline>`、图片→`<img>`；ESC/点外关闭；其他类型双击=选中（不预览） |
| Web 来源 | `apps/web/src/apps/files/types.ts` / `FileList.tsx` / `utils.ts` | `FileItem.source`；web 上传文件加小角标（如 `↥` 或不同色图标） |

---

## 六、安全

| 风险 | 缓解 |
|---|---|
| 前端伪造 `source=agent` | `source` 由 gateway 服务端写死，前端不可控 |
| 浏览器持有写 SAS 被滥用 | 代理方案下浏览器**全程不接触 SAS**，gateway 用自身凭证写 |
| 路径穿越 `../../<别人 uuid>` | `validateVirtualPath` 拒 `..`/绝对路径；blob name 强制 `<user_id>/` 前缀拼接 |
| 上传超大文件打爆内存 | multer `limits.fileSize=10MB` + 服务端 413；memoryStorage 上限受控 |
| 跨租户下载 | agent SAS 严格限定 `<user_id>/` 前缀，Azure 服务端拒绝越界 |
| 中文文件名 | title 走 b64 metadata；blob name 段用 UTF-8（Azure 支持） |

---

## 七、错误处理

| 场景 | 处理 |
|---|---|
| 上传 >10MB | 前端选择时即拦并提示；服务端 413 兜底 |
| 上传 path 非法 | 400，前端提示"文件名含非法字符" |
| 未启用 cloud | 403，理论上 UI 不可达（无 entitlement 不显示文件 App） |
| 上传网络失败 | 进度项标红 + `[重试]` |
| 批量部分失败 | 失败项独立标红，其余成功照常；汇总提示"N 成功 / M 失败" |
| download blob 不存在 | CLI 非零退出码 + stderr 清晰信息 |
| download SAS 过期 | 刷新 SAS 重试一次（复用 uploader 模式） |
| 预览加载失败 | 预览 modal 显示"预览失败 · [下载]" |

---

## 八、测试

### Gateway（`test/api/cloud.test.ts` 扩展）
1. `upload` 正常 → blob 写入 + metadata.source='web' + content_type 正确；
2. `upload` >10MB → 413；
3. `upload` path 含 `..` / 绝对路径 → 400；
4. `upload` 覆盖同名 → 内容更新；
5. `upload` 多租户：A 的 session 不能写到 B 的前缀；
6. `list` 解码并透传 `source`，旧文件缺省 `agent`。

### Agent CLI（`tests/test_downloader.py` 新增）
1. `--list` 解析 SAS、列出、解码 metadata；
2. `--virtual-path --output` 下载 → sha256 与源一致；
3. blob 不存在 → 退出码 3；
4. 403 SAS 失效 → 刷新重试一次；
5. 5xx → 指数退避。

### Web（files 相关单测）
1. 上传按钮/拖拽触发；冲突汇总 modal 三选项行为；
2. 上传进度回调；部分失败标红；
3. 单击选中 / Cmd 多选 / Shift 范围；
4. 双击：文件夹 navigate、PDF/图片预览、其他类型=选中；
5. 工具栏 `[下载]` 多选逐个触发、`[预览]` 仅单选可预览类型可用；
6. source 角标渲染。

### 端到端
- web 上传 `data.csv` → agent `cloud-download --virtual-path data.csv` 取回 → sha256 匹配；
- agent `cloud-publish` 产出 → web list 显示 `source=agent`（无角标）。

---

## 九、数据库

无需新表与迁移 —— 来源等元数据全部存 Blob metadata。

---

## 十、实施阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P1** | gateway `POST /api/cloud/upload`（multer + 校验 + 写 Blob + source=web）、`/list` 透传 source | 单测 1–6 |
| **P2** | `cloud-publish` metadata 加 `source=agent` | publish 后 list 显示 agent |
| **P3** | `cloud-download` CLI（list + download）+ setup entry point + SKILL.md | `tests/test_downloader.py` 全过 |
| **P4** | web 上传 UI（按钮/拖拽/并发/进度/冲突汇总确认/source 角标） | web 上传单测 1–2、6 |
| **P5** | web 下载交互改版（选中/多选/双击预览/工具栏 + 预览 modal） | web 单测 3–5 |
| **P6** | 端到端（web 上传 → agent 下载 sha256 匹配） | 端到端通过 |
