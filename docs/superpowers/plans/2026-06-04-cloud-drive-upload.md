# 云盘反向功能（web 上传 → agent 下载）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在 web "文件" App 上传文件到私有云盘，hermes agent 通过新的 `cloud-download` CLI 列出并下载这些文件来使用。

**Architecture:** Web 上传走 **gateway 代理**（浏览器 → multipart → gateway → Azure Blob，gateway 用自身凭证写并打 `source=web` 标记，浏览器不接触 SAS）。Agent 下载**复用现有 `/api/cloud/sas`** 签发的目录 SAS（权限 `racwl` 已含 read+list），新增 `cloud-download` CLI 直连 Blob 列出/下载，无新 gateway 数据面端点。Web 下载交互改版为：单击选中（多选）、双击预览、选中后顶部工具栏 `[预览][下载]`。

**Tech Stack:** TS / Express / `@azure/storage-blob` / multer（gateway）· Python / `azure-storage-blob`（agent CLI）· React / vitest / @testing-library（web）。测试：gateway 用 vitest + supertest，Python 用 pytest，web 用 vitest + jsdom。

**Spec:** `docs/superpowers/specs/2026-06-04-cloud-drive-upload-design.md`

---

## File Structure

**Gateway（`apps/gateway/`）**
- Modify `src/api/cloud.ts` — 新增 `POST /api/cloud/upload`；`/list` 透传 `source`；加 `encodeB64Utf8` 与 multer 中间件
- Modify `package.json` — 加 `multer` + `@types/multer`
- Modify `test/api/cloud.test.ts` — upload 端点测试 + list source 测试

**Shared（`packages/shared/`）**
- Modify `src/contracts.ts` — `CloudFileItem.metadata.source`；新增 `CloudUploadResponse`

**Agent CLI（`docker/hermes/skills/cloud/`）**
- Create `cloud_publish/paths.py` — 抽出 `validate_virtual_path`（publish + download 共用）
- Modify `cloud_publish/__main__.py` — 改用 `paths.validate_virtual_path`
- Modify `cloud_publish/metadata.py` — `build_metadata` 增加 `source='agent'`
- Create `cloud_publish/downloader.py` — `list_files` + `download_file`
- Create `cloud_publish/download_cli.py` — `cloud-download` 入口
- Modify `setup.py` — 加 `cloud-download` console script
- Modify `SKILL.md` — 文档化 `cloud-download`
- Create `tests/test_paths.py` / `tests/test_downloader.py` / `tests/test_download_cli.py`

**Web（`apps/web/`）**
- Modify `src/lib/api.ts` — `cloudUpload`（XHR 带进度）
- Modify `src/apps/files/types.ts` — `FileItem.source`
- Modify `src/apps/files/utils.ts` — `isPreviewable` + `sourceBadge`
- Modify `src/apps/files/FileList.tsx` — 选中高亮、单击选中、双击激活、source 角标
- Modify `src/apps/files/PathBar.tsx` — `[上传][预览][下载]` 工具栏
- Create `src/apps/files/Preview.tsx` — 预览 modal
- Create `src/apps/files/UploadController.tsx` — 上传按钮 + 拖拽 + 冲突汇总 modal + 进度
- Modify `src/apps/files/FilesApp.tsx` — 串起选中 / 预览 / 上传
- Modify `test/FileList.test.tsx` / `test/FilesApp.test.tsx`；Create `test/Preview.test.tsx` / `test/UploadController.test.tsx` / `test/cloudUpload.test.ts`

---

## Task 1: Shared contracts — `source` 字段 + 上传响应类型

**Files:**
- Modify: `packages/shared/src/contracts.ts:200-213`

- [ ] **Step 1: 给 `CloudFileItem.metadata` 加 `source`，并新增 `CloudUploadResponse`**

在 `contracts.ts` 中找到 `CloudFileItem`（约 200 行），把 `metadata` 块改成包含 `source`，并在 `CloudListResponse` 之后追加新接口：

```ts
export interface CloudFileItem {
  virtual_path: string;       // relative to <user_id>/
  size: number;
  last_modified: string;      // ISO-8601
  content_type: string | null;
  metadata: {
    title: string;            // decoded UTF-8
    session_id: string | null;
    published_at: string | null;
    tool_version: string | null;
    description: string | null;
    tags: string[] | null;
    source: 'web' | 'agent';  // 文件来源：web 上传 or agent 发布；旧文件缺省 'agent'
  };
}
```

在 `CloudListResponse` 接口之后追加：

```ts
/**
 * Web 上传响应 (POST /api/cloud/upload)。
 * gateway 代理写 Blob 成功后返回。
 */
export interface CloudUploadResponse {
  ok: true;
  virtual_path: string;       // relative to <user_id>/
  size: number;               // bytes written
  last_modified: string;      // ISO-8601
}
```

- [ ] **Step 2: 构建 shared 包验证类型通过**

Run: `pnpm --filter @lingxi/shared build`
Expected: 构建成功，无类型错误。（若仓库用 npm/yarn，对应换成 `npm run build -w @lingxi/shared`）

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/contracts.ts
git commit -m "feat(shared): cloud file source field + CloudUploadResponse contract"
```

---

## Task 2: Gateway `/api/cloud/list` 透传 `source`

**Files:**
- Modify: `apps/gateway/src/api/cloud.ts:204-214`（`decodeBlobMetadata`）
- Test: `apps/gateway/test/api/cloud.test.ts`

- [ ] **Step 1: 写失败测试 —— list 透传 source（web）+ 缺省 agent**

在 `cloud.test.ts` 的 `describe('GET /api/cloud/list', ...)` 内，紧接现有 `it('handles file without metadata ...')` 之后追加两个用例（复用文件内已有的 `fakeListBlobs` / `makeListApp`）：

```ts
  it('passes through source=web from metadata', async () => {
    const listFn = vi.fn(() => fakeListBlobs([
      { kind: 'blob', name: `${USER_ID}/data.csv`, size: 10,
        meta: { title: Buffer.from('data').toString('base64'), source: 'web' } },
    ])());
    const app = makeListApp({ listFn });
    const res = await request(app).get('/api/cloud/list');
    expect(res.body.files[0].metadata.source).toBe('web');
  });

  it('defaults source to agent when metadata.source absent', async () => {
    const listFn = vi.fn(() => fakeListBlobs([
      { kind: 'blob', name: `${USER_ID}/old.pdf`, size: 10, meta: {} },
    ])());
    const app = makeListApp({ listFn });
    const res = await request(app).get('/api/cloud/list');
    expect(res.body.files[0].metadata.source).toBe('agent');
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @lingxi/gateway test -- cloud.test.ts`
Expected: 两个新用例 FAIL（`metadata.source` 为 `undefined`）。

- [ ] **Step 3: 在 `decodeBlobMetadata` 里返回 source**

`cloud.ts` 的 `decodeBlobMetadata`（约 204 行）返回对象末尾加一行 `source`：

```ts
function decodeBlobMetadata(raw: Record<string, string>, fallbackRelPath: string): CloudFileItem['metadata'] {
  const tagsRaw = decodeB64Utf8(raw['tags']);
  return {
    title: decodeB64Utf8(raw['title']) ?? fallbackRelPath.split('/').pop() ?? fallbackRelPath,
    session_id: raw['session_id'] ?? null,
    published_at: raw['published_at'] ?? null,
    tool_version: raw['tool_version'] ?? null,
    description: decodeB64Utf8(raw['description']),
    tags: tagsRaw ? tagsRaw.split(',').map(s => s.trim()).filter(Boolean) : null,
    source: raw['source'] === 'web' ? 'web' : 'agent',
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @lingxi/gateway test -- cloud.test.ts`
Expected: 全 describe('GET /api/cloud/list') PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/api/cloud.ts apps/gateway/test/api/cloud.test.ts
git commit -m "feat(gateway): list 透传 metadata.source (缺省 agent)"
```

---

## Task 3: Gateway `POST /api/cloud/upload` 端点

**Files:**
- Modify: `apps/gateway/package.json`（加 multer 依赖）
- Modify: `apps/gateway/src/api/cloud.ts`（imports、`encodeB64Utf8`、upload 路由）
- Test: `apps/gateway/test/api/cloud.test.ts`

- [ ] **Step 1: 装 multer 依赖**

```bash
pnpm --filter @lingxi/gateway add multer && pnpm --filter @lingxi/gateway add -D @types/multer
```
Expected: `apps/gateway/package.json` 的 dependencies 出现 `multer`、devDependencies 出现 `@types/multer`。

- [ ] **Step 2: 写失败测试 —— upload 成功路径 + 校验 + 多租户**

在 `cloud.test.ts` 末尾（最后一个 `describe` 之后）追加：

```ts
describe('POST /api/cloud/upload', () => {
  function makeUploadApp(opts: { listActive?: any; uploadData?: any; sessionUserId?: string } = {}) {
    const userId = opts.sessionUserId ?? USER_ID;
    const uploadData = opts.uploadData ?? vi.fn().mockResolvedValue(undefined);
    const getBlockBlobClient = vi.fn((_name: string) => ({ uploadData }));
    const app = express();
    app.use(express.json());
    app.use(buildCloudRouter({
      secret: SECRET,
      config: { accountName: ACCOUNT, container: CONTAINER, blobEndpoint: BLOB_ENDPOINT, writeSasTtlSeconds: 900, readSasTtlSeconds: 300 },
      entitlements: {
        listActive: opts.listActive ?? vi.fn().mockResolvedValue(['cloud']),
        getTokenVersion: vi.fn().mockResolvedValue(0),
      } as any,
      udkCache: { get: vi.fn() } as any,
      blobServiceClient: {
        getContainerClient: () => ({
          getBlockBlobClient,
          listBlobsByHierarchy: () => (async function*() {})(),
          getBlobClient: () => ({ getProperties: vi.fn() }),
        }),
      } as any,
      sessionMw: ((req: any, _res: any, next: any) => { req.session = { user_id: userId }; next(); }) as any,
    }));
    return { app, uploadData, getBlockBlobClient };
  }

  it('uploads a file and writes source=web metadata', async () => {
    const { app, uploadData, getBlockBlobClient } = makeUploadApp();
    const res = await request(app)
      .post('/api/cloud/upload')
      .field('virtual_path', 'inbox/data.csv')
      .field('title', '我的数据')
      .attach('file', Buffer.from('a,b,c\n1,2,3'), 'data.csv');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.virtual_path).toBe('inbox/data.csv');
    // blob name 必须前缀到 session user_id（多租户隔离）
    expect(getBlockBlobClient).toHaveBeenCalledWith(`${USER_ID}/inbox/data.csv`);
    const opts = uploadData.mock.calls[0][1];
    expect(opts.metadata.source).toBe('web');
    expect(Buffer.from(opts.metadata.title, 'base64').toString('utf8')).toBe('我的数据');
    expect(opts.blobHTTPHeaders.blobContentType).toMatch(/csv|text|octet/);
  });

  it('400 when virtual_path missing', async () => {
    const { app } = makeUploadApp();
    const res = await request(app).post('/api/cloud/upload').attach('file', Buffer.from('x'), 'x.txt');
    expect(res.status).toBe(400);
  });

  it('400 when file field missing', async () => {
    const { app } = makeUploadApp();
    const res = await request(app).post('/api/cloud/upload').field('virtual_path', 'x.txt');
    expect(res.status).toBe(400);
  });

  it('400 on path traversal', async () => {
    const { app } = makeUploadApp();
    const res = await request(app)
      .post('/api/cloud/upload')
      .field('virtual_path', '../other/x.txt')
      .attach('file', Buffer.from('x'), 'x.txt');
    expect(res.status).toBe(400);
  });

  it('413 when file exceeds 10MB', async () => {
    const { app } = makeUploadApp();
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0x61);
    const res = await request(app)
      .post('/api/cloud/upload')
      .field('virtual_path', 'big.bin')
      .attach('file', big, 'big.bin');
    expect(res.status).toBe(413);
  });

  it('403 when cloud entitlement not active', async () => {
    const { app } = makeUploadApp({ listActive: vi.fn().mockResolvedValue([]) });
    const res = await request(app)
      .post('/api/cloud/upload')
      .field('virtual_path', 'x.txt')
      .attach('file', Buffer.from('x'), 'x.txt');
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @lingxi/gateway test -- cloud.test.ts`
Expected: 新 describe FAIL（路由 404 / 字段未定义）。

- [ ] **Step 4: 实现 upload 路由**

`cloud.ts` 顶部 import 区加：

```ts
import multer from 'multer';
import type { CloudWriteSasResponse, CloudListResponse, CloudFileItem, CloudFolderItem, CloudUploadResponse } from '@lingxi/shared';
```

（把现有 `import type { CloudWriteSasResponse, CloudListResponse, CloudFileItem, CloudFolderItem }` 那行替换为上面这行——多加 `CloudUploadResponse`。）

在 `const FEATURE = 'cloud';` 之后加 multer 实例 + 错误包装中间件：

```ts
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

const uploadMw = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

const uploadSingle: RequestHandler = (req, res, next) => {
  uploadMw.single('file')(req, res, (err: any) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: 'file too large (10MB limit)' });
        return;
      }
      res.status(400).json({ error: String(err?.message ?? err) });
      return;
    }
    next();
  });
};
```

在 `buildCloudRouter` 内、`/api/cloud/download` 路由之后（`return router;` 之前）加上传路由：

```ts
  router.post('/api/cloud/upload', deps.sessionMw, uploadSingle, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;

    const active = await deps.entitlements.listActive(userId);
    if (!active.includes(FEATURE)) {
      res.status(403).json({ error: 'cloud entitlement not active' });
      return;
    }

    const file = (req as any).file as { buffer: Buffer; mimetype?: string; originalname?: string } | undefined;
    if (!file) {
      res.status(400).json({ error: 'file field required' });
      return;
    }

    const virtualPath = (req.body?.virtual_path as string | undefined)?.trim() ?? '';
    if (!virtualPath) {
      res.status(400).json({ error: 'virtual_path field required' });
      return;
    }
    const v = validateVirtualPath(virtualPath);
    if (!v.ok) {
      res.status(400).json({ error: `invalid virtual_path: ${v.error}` });
      return;
    }

    const title = (req.body?.title as string | undefined)?.trim() || virtualPath.split('/').pop() || virtualPath;
    const contentType = file.mimetype || 'application/octet-stream';
    const fullPath = `${userId}/${virtualPath}`;
    const nowIso = new Date().toISOString();

    try {
      const containerClient = deps.blobServiceClient.getContainerClient(deps.config.container);
      const blockBlob = (containerClient as any).getBlockBlobClient(fullPath);
      await blockBlob.uploadData(file.buffer, {
        blobHTTPHeaders: { blobContentType: contentType },
        metadata: {
          title: encodeB64Utf8(title),
          published_at: nowIso,
          tool_version: '0.1.0',
          source: 'web',
        },
      });
      const body: CloudUploadResponse = {
        ok: true,
        virtual_path: virtualPath,
        size: file.buffer.length,
        last_modified: nowIso,
      };
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: 'blob upload failed', message: String(err) });
    }
  });
```

在文件底部 `decodeB64Utf8` 函数旁边加编码工具：

```ts
function encodeB64Utf8(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @lingxi/gateway test -- cloud.test.ts`
Expected: 整个 cloud.test.ts 全 PASS（含 sas/list/download/upload）。

- [ ] **Step 6: 类型检查**

Run: `pnpm --filter @lingxi/gateway lint`
Expected: `tsc --noEmit` 无错误。

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/package.json apps/gateway/src/api/cloud.ts apps/gateway/test/api/cloud.test.ts
git commit -m "feat(gateway): POST /api/cloud/upload (multer 代理 → Blob, source=web)"
```

> 注：路由挂在 `buildCloudRouter` 内，`index.ts` 的挂载点（约 187 行）无需改动。

---

## Task 4: cloud-publish — 抽出 `validate_virtual_path` 到 `paths.py`

**Files:**
- Create: `docker/hermes/skills/cloud/cloud_publish/paths.py`
- Modify: `docker/hermes/skills/cloud/cloud_publish/__main__.py:34-78`
- Test: `docker/hermes/skills/cloud/tests/test_paths.py`

- [ ] **Step 1: 写失败测试**

创建 `tests/test_paths.py`：

```python
"""Unit tests for cloud_publish.paths.validate_virtual_path."""
import pytest
from cloud_publish.paths import validate_virtual_path


class TestValid:
    @pytest.mark.parametrize('vpath', ['a.txt', 'reports/2026/sales.pdf', '销售/报告.pdf'])
    def test_accepts(self, vpath):
        validate_virtual_path(vpath)  # no raise


class TestInvalid:
    @pytest.mark.parametrize('vpath,msg', [
        ('/abs.txt', "must not start with '/'"),
        ('dir/', "must not end with '/'"),
        ('a/../b', "'..'"),
        ('a//b', 'empty segments'),
        ('x' * 1025, 'too long'),
    ])
    def test_rejects(self, vpath, msg):
        with pytest.raises(ValueError, match=msg.replace('.', r'\.')):
            validate_virtual_path(vpath)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd docker/hermes/skills/cloud && python -m pytest tests/test_paths.py -v`
Expected: FAIL（`No module named cloud_publish.paths`）。

- [ ] **Step 3: 创建 `paths.py`（从 `__main__.py` 搬出逻辑）**

```python
"""Virtual-path validation shared by cloud-publish and cloud-download."""

import re

_MAX_SEGMENT_LEN = 200
_MAX_PATH_LEN = 1024
_CONTROL_CHAR_RE = re.compile(r'[\x00-\x1f\x7f]')


def validate_virtual_path(vpath: str) -> None:
    """Raise ValueError if virtual_path is invalid.

    Rules: no leading/trailing '/', no '..' segments, no empty segments,
    no control chars, segment ≤ 200 chars, total ≤ 1024 chars.
    """
    if vpath.startswith('/'):
        raise ValueError("virtual-path must not start with '/'")
    if vpath.endswith('/'):
        raise ValueError("virtual-path must not end with '/'")
    if len(vpath) > _MAX_PATH_LEN:
        raise ValueError(f'virtual-path too long: {len(vpath)} chars > {_MAX_PATH_LEN}')
    if _CONTROL_CHAR_RE.search(vpath):
        raise ValueError('virtual-path contains control characters')
    for segment in vpath.split('/'):
        if segment == '..':
            raise ValueError("virtual-path must not contain '..' segments")
        if not segment:
            raise ValueError('virtual-path must not contain empty segments (double slash)')
        if len(segment) > _MAX_SEGMENT_LEN:
            raise ValueError(
                f"virtual-path segment '{segment}' too long: "
                f'{len(segment)} chars > {_MAX_SEGMENT_LEN}'
            )
```

- [ ] **Step 4: 改 `__main__.py` 改用 paths**

在 `__main__.py` 顶部 import 区加：

```python
from cloud_publish.paths import validate_virtual_path  # noqa: E402
```

删除 `__main__.py` 里的常量 `_MAX_SEGMENT_LEN` / `_MAX_PATH_LEN` / `_CONTROL_CHAR_RE`（34-37 行附近，保留 `_MAX_FILE_BYTES`）和整个 `_validate_virtual_path` 函数（57-78 行）。

把 `main()` 里的调用（约 123 行）改为：

```python
    try:
        validate_virtual_path(virtual_path)
    except ValueError as exc:
        _fail(str(exc), 1)
```

- [ ] **Step 5: 跑全部 Python 测试确认通过**

Run: `cd docker/hermes/skills/cloud && python -m pytest -v`
Expected: `test_paths.py` 全 PASS，且 `test_main.py` 等原有用例仍 PASS（回归）。

- [ ] **Step 6: Commit**

```bash
git add docker/hermes/skills/cloud/cloud_publish/paths.py \
        docker/hermes/skills/cloud/cloud_publish/__main__.py \
        docker/hermes/skills/cloud/tests/test_paths.py
git commit -m "refactor(cloud): 抽出 validate_virtual_path 到 paths.py (publish/download 共用)"
```

---

## Task 5: cloud-publish — metadata 打 `source='agent'`

**Files:**
- Modify: `docker/hermes/skills/cloud/cloud_publish/metadata.py:19-60`
- Test: `docker/hermes/skills/cloud/tests/test_metadata.py`

- [ ] **Step 1: 写失败测试**

在 `tests/test_metadata.py` 末尾追加：

```python
def test_source_defaults_to_agent():
    from cloud_publish.metadata import build_metadata
    meta = build_metadata(title='x')
    assert meta['source'] == 'agent'


def test_source_can_be_overridden():
    from cloud_publish.metadata import build_metadata
    meta = build_metadata(title='x', source='web')
    assert meta['source'] == 'web'
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd docker/hermes/skills/cloud && python -m pytest tests/test_metadata.py -v`
Expected: 两个新用例 FAIL（`KeyError: 'source'`）。

- [ ] **Step 3: 给 `build_metadata` 加 source 参数**

`metadata.py` 的 `build_metadata` 签名加参数，meta dict 里加 source：

```python
def build_metadata(
    title: str,
    session_id: str | None = None,
    published_at: str | None = None,
    tool_version: str = '0.1.0',
    description: str | None = None,
    tags: list[str] | None = None,
    source: str = 'agent',
) -> dict[str, str]:
```

在 `meta` 初始化里加 `'source': source`：

```python
    meta: dict[str, str] = {
        'title': _b64(title),
        'published_at': published_at,
        'tool_version': tool_version,
        'source': source,
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd docker/hermes/skills/cloud && python -m pytest tests/test_metadata.py -v`
Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add docker/hermes/skills/cloud/cloud_publish/metadata.py docker/hermes/skills/cloud/tests/test_metadata.py
git commit -m "feat(cloud): cloud-publish metadata 打 source=agent"
```

---

## Task 6: cloud-download — `downloader.py`（list + download）

**Files:**
- Create: `docker/hermes/skills/cloud/cloud_publish/downloader.py`
- Test: `docker/hermes/skills/cloud/tests/test_downloader.py`

- [ ] **Step 1: 写失败测试（镜像 test_uploader 的 mock 风格）**

创建 `tests/test_downloader.py`：

```python
"""Unit tests for cloud_publish.downloader."""
import unittest.mock as mock
import datetime

import pytest
from azure.core.exceptions import HttpResponseError

from cloud_publish.downloader import list_files, download_file

_SAS = {
    'blob_endpoint': 'https://laifuprod.blob.core.windows.net',
    'container': 'laifu-cloud',
    'prefix': 'user123/',
    'sas_token': 'sv=2024&sig=abc',
}


def _http_error(status: int) -> HttpResponseError:
    exc = HttpResponseError(message=f'HTTP {status}')
    exc.status_code = status
    return exc


def _fake_blob(name, size, title_b64=None, source=None, ct='text/csv'):
    b = mock.MagicMock()
    b.name = name
    b.size = size
    b.last_modified = datetime.datetime(2026, 6, 4, tzinfo=datetime.timezone.utc)
    b.content_settings = mock.MagicMock(content_type=ct)
    meta = {}
    if title_b64:
        meta['title'] = title_b64
    if source:
        meta['source'] = source
    b.metadata = meta
    return b


class TestListFiles:
    def test_strips_user_prefix_and_decodes_title(self):
        import base64
        title_b64 = base64.b64encode('销售'.encode()).decode()
        with mock.patch('cloud_publish.downloader.ContainerClient') as MockCC:
            inst = MockCC.from_container_url.return_value
            inst.list_blobs.return_value = [
                _fake_blob('user123/reports/q2.pdf', 100, title_b64, source='web'),
            ]
            out = list_files(_SAS)
        assert out[0]['virtual_path'] == 'reports/q2.pdf'
        assert out[0]['title'] == '销售'
        assert out[0]['source'] == 'web'
        assert out[0]['size'] == 100

    def test_source_defaults_to_agent(self):
        with mock.patch('cloud_publish.downloader.ContainerClient') as MockCC:
            inst = MockCC.from_container_url.return_value
            inst.list_blobs.return_value = [_fake_blob('user123/a.txt', 1)]
            out = list_files(_SAS)
        assert out[0]['source'] == 'agent'

    def test_passes_full_prefix_to_list_blobs(self):
        with mock.patch('cloud_publish.downloader.ContainerClient') as MockCC:
            inst = MockCC.from_container_url.return_value
            inst.list_blobs.return_value = []
            list_files(_SAS, sub_prefix='reports/')
        kwargs = inst.list_blobs.call_args.kwargs
        assert kwargs['name_starts_with'] == 'user123/reports/'


class TestDownloadFile:
    def test_writes_file_and_returns_size(self, tmp_path):
        out = tmp_path / 'q2.pdf'
        with mock.patch('cloud_publish.downloader.BlobClient') as MockBC:
            inst = MockBC.from_blob_url.return_value
            inst.download_blob.return_value.readall.return_value = b'hello-bytes'
            size = download_file(_SAS, 'reports/q2.pdf', str(out))
        assert out.read_bytes() == b'hello-bytes'
        assert size == len(b'hello-bytes')

    def test_404_raises_filenotfound(self, tmp_path):
        with mock.patch('cloud_publish.downloader.BlobClient') as MockBC:
            inst = MockBC.from_blob_url.return_value
            inst.download_blob.side_effect = _http_error(404)
            with pytest.raises(FileNotFoundError):
                download_file(_SAS, 'missing.pdf', str(tmp_path / 'x'))

    def test_403_force_refresh_then_succeeds(self, tmp_path):
        out = tmp_path / 'q2.pdf'
        with mock.patch('cloud_publish.downloader.BlobClient') as MockBC:
            inst = MockBC.from_blob_url.return_value
            inst.download_blob.side_effect = [
                _http_error(403),
                mock.MagicMock(readall=mock.MagicMock(return_value=b'ok')),
            ]
            sas_cache = mock.MagicMock()
            sas_cache.force_refresh.return_value = {**_SAS, 'sas_token': 'sv=2024&sig=new'}
            size = download_file(_SAS, 'reports/q2.pdf', str(out), sas_cache=sas_cache)
        sas_cache.force_refresh.assert_called_once()
        assert out.read_bytes() == b'ok'
        assert size == 2

    def test_5xx_retries_then_raises(self, tmp_path):
        with mock.patch('cloud_publish.downloader.BlobClient') as MockBC, \
             mock.patch('cloud_publish.downloader.time.sleep') as mock_sleep:
            inst = MockBC.from_blob_url.return_value
            inst.download_blob.side_effect = _http_error(500)
            with pytest.raises(RuntimeError, match='retries'):
                download_file(_SAS, 'x.pdf', str(tmp_path / 'x'))
        assert inst.download_blob.call_count == 4  # initial + 3 retries
        assert [c.args[0] for c in mock_sleep.call_args_list] == [1.0, 2.0, 4.0]
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd docker/hermes/skills/cloud && python -m pytest tests/test_downloader.py -v`
Expected: FAIL（`No module named cloud_publish.downloader`）。

- [ ] **Step 3: 实现 `downloader.py`**

```python
"""Blob lister + downloader for cloud-download.

Reuses the SAS issued by GET /api/cloud/sas (permissions racwl → read + list).
"""

import base64
import time
from typing import TYPE_CHECKING

from azure.core.exceptions import HttpResponseError
from azure.storage.blob import BlobClient, ContainerClient

if TYPE_CHECKING:
    from cloud_publish.sas_cache import SasCache

_MAX_RETRIES = 3
_INITIAL_BACKOFF_SECONDS = 1.0


def _b64_decode(s: str | None) -> str | None:
    if not s:
        return None
    try:
        return base64.b64decode(s).decode('utf-8')
    except Exception:
        return None


def list_files(sas: dict, sub_prefix: str = '') -> list[dict]:
    """Flat-recursive list of all blobs under the user's prefix.

    Returns a list of dicts: virtual_path, size, last_modified, content_type,
    source, title. `sub_prefix` (e.g. 'reports/') narrows the listing.
    """
    user_prefix = sas.get('prefix', '')  # "<user_id>/"
    container_url = f"{sas['blob_endpoint']}/{sas['container']}?{sas['sas_token']}"
    client = ContainerClient.from_container_url(container_url)
    full_prefix = f'{user_prefix}{sub_prefix}'

    out: list[dict] = []
    for blob in client.list_blobs(name_starts_with=full_prefix, include=['metadata']):
        rel = blob.name[len(user_prefix):]
        meta = blob.metadata or {}
        ct = blob.content_settings.content_type if blob.content_settings else None
        out.append({
            'virtual_path': rel,
            'size': blob.size,
            'last_modified': blob.last_modified.isoformat() if blob.last_modified else None,
            'content_type': ct,
            'source': meta.get('source', 'agent'),
            'title': _b64_decode(meta.get('title')) or rel.split('/')[-1],
        })
    return out


def _blob_url(sas: dict, virtual_path: str) -> str:
    blob_name = f"{sas.get('prefix', '')}{virtual_path}"
    return f"{sas['blob_endpoint']}/{sas['container']}/{blob_name}?{sas['sas_token']}"


def _download_once(blob_url: str, output_path: str) -> int:
    client = BlobClient.from_blob_url(blob_url)
    data = client.download_blob().readall()
    with open(output_path, 'wb') as fh:
        fh.write(data)
    return len(data)


def download_file(
    sas: dict,
    virtual_path: str,
    output_path: str,
    sas_cache: 'SasCache | None' = None,
) -> int:
    """Download a single blob to output_path; return bytes written.

    Retries 3x on 5xx (backoff 1/2/4 s). 403 → force-refresh SAS once.
    404 → FileNotFoundError. Non-retryable 4xx propagate.
    """
    blob_url = _blob_url(sas, virtual_path)
    backoff = _INITIAL_BACKOFF_SECONDS
    last_exc: Exception | None = None

    for attempt in range(_MAX_RETRIES + 1):
        try:
            return _download_once(blob_url, output_path)
        except HttpResponseError as exc:
            status = exc.status_code if exc.status_code is not None else 0

            if status == 404:
                raise FileNotFoundError(f'blob not found: {virtual_path}') from exc

            if status == 403:
                if sas_cache is not None:
                    sas = sas_cache.force_refresh()
                    blob_url = _blob_url(sas, virtual_path)
                    try:
                        return _download_once(blob_url, output_path)
                    except HttpResponseError as retry_exc:
                        raise RuntimeError(
                            f'Download failed after SAS force-refresh: {retry_exc}'
                        ) from retry_exc
                raise RuntimeError(f'Download 403 (no SAS cache to refresh): {exc}') from exc

            if 500 <= status < 600:
                last_exc = exc
                if attempt < _MAX_RETRIES:
                    time.sleep(backoff)
                    backoff *= 2
                continue

            raise

    raise RuntimeError(f'Download failed after {_MAX_RETRIES} retries: {last_exc}') from last_exc
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd docker/hermes/skills/cloud && python -m pytest tests/test_downloader.py -v`
Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add docker/hermes/skills/cloud/cloud_publish/downloader.py docker/hermes/skills/cloud/tests/test_downloader.py
git commit -m "feat(cloud): downloader 模块 (list_files + download_file, 复用 racwl SAS)"
```

---

## Task 7: cloud-download — CLI 入口 + setup entry point

**Files:**
- Create: `docker/hermes/skills/cloud/cloud_publish/download_cli.py`
- Modify: `docker/hermes/skills/cloud/setup.py:12-16`
- Test: `docker/hermes/skills/cloud/tests/test_download_cli.py`

- [ ] **Step 1: 写失败测试**

创建 `tests/test_download_cli.py`：

```python
"""Unit tests for cloud_publish.download_cli."""
import json
import unittest.mock as mock

import pytest

from cloud_publish import download_cli


def _run(argv, env, capsys):
    with mock.patch('sys.argv', ['cloud-download', *argv]), \
         mock.patch.dict('os.environ', env, clear=True):
        try:
            download_cli.main()
            code = 0
        except SystemExit as e:
            code = e.code
    out = capsys.readouterr().out.strip()
    return code, out


_ENV = {'GATEWAY_BASE_URL': 'https://gw.test', 'LAIFU_USER_TOKEN': 'jwt123'}
_SAS = {'blob_endpoint': 'https://b.net', 'container': 'laifu-cloud',
        'prefix': 'user123/', 'sas_token': 'sig', 'expires_at': '2099-01-01T00:00:00Z'}


def test_list_outputs_files_json(capsys):
    with mock.patch('cloud_publish.download_cli.SasCache') as MockSas, \
         mock.patch('cloud_publish.download_cli.list_files') as mock_list:
        MockSas.return_value.get.return_value = _SAS
        mock_list.return_value = [{'virtual_path': 'a.txt', 'size': 1, 'source': 'web',
                                   'last_modified': None, 'content_type': 'text/plain', 'title': 'a'}]
        code, out = _run(['--list'], _ENV, capsys)
    assert code == 0
    body = json.loads(out)
    assert body['ok'] is True
    assert body['files'][0]['virtual_path'] == 'a.txt'


def test_download_writes_and_reports(capsys):
    with mock.patch('cloud_publish.download_cli.SasCache') as MockSas, \
         mock.patch('cloud_publish.download_cli.download_file') as mock_dl:
        MockSas.return_value.get.return_value = _SAS
        mock_dl.return_value = 2048
        code, out = _run(['--virtual-path', 'reports/q2.pdf', '--output', '/tmp/q2.pdf'], _ENV, capsys)
    assert code == 0
    body = json.loads(out)
    assert body['ok'] is True
    assert body['virtual_path'] == 'reports/q2.pdf'
    assert body['size'] == 2048
    assert body['output'] == '/tmp/q2.pdf'


def test_missing_jwt_exit_2(capsys):
    code, out = _run(['--list'], {'GATEWAY_BASE_URL': 'https://gw.test'}, capsys)
    assert code == 2


def test_download_requires_output(capsys):
    code, _ = _run(['--virtual-path', 'a.txt'], _ENV, capsys)
    assert code == 1


def test_path_traversal_exit_1(capsys):
    code, _ = _run(['--virtual-path', '../x', '--output', '/tmp/x'], _ENV, capsys)
    assert code == 1


def test_blob_missing_exit_3(capsys):
    with mock.patch('cloud_publish.download_cli.SasCache') as MockSas, \
         mock.patch('cloud_publish.download_cli.download_file') as mock_dl:
        MockSas.return_value.get.return_value = _SAS
        mock_dl.side_effect = FileNotFoundError('blob not found: a.txt')
        code, _ = _run(['--virtual-path', 'a.txt', '--output', '/tmp/a'], _ENV, capsys)
    assert code == 3
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd docker/hermes/skills/cloud && python -m pytest tests/test_download_cli.py -v`
Expected: FAIL（`No module named cloud_publish.download_cli`）。

- [ ] **Step 3: 实现 `download_cli.py`**

```python
"""cloud-download CLI entry point.

Usage:
  cloud-download --list [--prefix PFX]          # 扁平递归列出前缀下所有文件
  cloud-download --virtual-path PATH --output FILE

Stdout: one-line JSON.
  --list:     {"ok": true, "files": [{...}]}
  --download: {"ok": true, "virtual_path": "...", "output": "...", "size": N}
  failure:    {"ok": false, "error": "<message>"}

Exit codes: 0 ok / 1 input error / 2 auth failure / 3 network|download / 4 other.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys

from cloud_publish.sas_cache import SasCache, AuthError
from cloud_publish.paths import validate_virtual_path
from cloud_publish.downloader import list_files, download_file


def _emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def _fail(msg: str, code: int) -> None:
    _emit({'ok': False, 'error': msg})
    sys.exit(code)


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog='cloud-download',
        description="List or download files from the user's laifu Cloud Drive.",
    )
    p.add_argument('--list', action='store_true', help='List files (flat, recursive)')
    p.add_argument('--prefix', default='', help="Narrow --list to this virtual prefix, e.g. reports/")
    p.add_argument('--virtual-path', default=None, dest='virtual_path',
                   help='Cloud path to download, e.g. reports/q2.pdf')
    p.add_argument('--output', default=None, help='Local output file path (required with --virtual-path)')
    return p


def main() -> None:
    args = _build_parser().parse_args()

    if not args.list and not args.virtual_path:
        _fail('either --list or --virtual-path is required', 1)
    if args.virtual_path and not args.output:
        _fail('--output is required when using --virtual-path', 1)

    # env
    gateway_base_url = os.environ.get('GATEWAY_BASE_URL', '').strip()
    jwt = os.environ.get('LAIFU_USER_TOKEN', '').strip()
    if not gateway_base_url:
        _fail('GATEWAY_BASE_URL environment variable not set', 4)
    if not jwt:
        _fail('LAIFU_USER_TOKEN environment variable not set', 2)

    # validate download path before any network
    if args.virtual_path:
        try:
            validate_virtual_path(args.virtual_path)
        except ValueError as exc:
            _fail(str(exc), 1)

    sas_cache_path = pathlib.Path.home() / '.hermes' / '_cloud_sas.json'
    sas_cache = SasCache(path=sas_cache_path, gateway_base_url=gateway_base_url, jwt=jwt)
    try:
        sas = sas_cache.get()
    except AuthError as exc:
        _fail(str(exc), 2)
    except Exception as exc:
        _fail(f'Failed to obtain SAS token: {exc}', 3)

    if args.list:
        try:
            files = list_files(sas, sub_prefix=args.prefix)
        except Exception as exc:
            _fail(f'list failed: {exc}', 3)
        _emit({'ok': True, 'files': files})
        return

    # download
    try:
        size = download_file(sas, args.virtual_path, args.output, sas_cache=sas_cache)
    except FileNotFoundError as exc:
        _fail(str(exc), 3)
    except RuntimeError as exc:
        _fail(str(exc), 3)
    except Exception as exc:
        _fail(f'Unexpected download error: {exc}', 4)

    _emit({'ok': True, 'virtual_path': args.virtual_path, 'output': args.output, 'size': size})


if __name__ == '__main__':
    main()
```

- [ ] **Step 4: 加 setup.py entry point**

`setup.py` 的 `entry_points.console_scripts` 改为两个：

```python
    entry_points={
        'console_scripts': [
            'cloud-publish=cloud_publish.__main__:main',
            'cloud-download=cloud_publish.download_cli:main',
        ],
    },
```

- [ ] **Step 5: 跑全部 Python 测试确认通过**

Run: `cd docker/hermes/skills/cloud && python -m pytest -v`
Expected: 全 PASS（paths / metadata / downloader / download_cli / 原有 uploader / main / sas_cache）。

- [ ] **Step 6: 验证 entry point 可装（可选 sanity）**

Run: `cd docker/hermes/skills/cloud && pip install -e . >/dev/null 2>&1 && cloud-download 2>&1 | head -1; echo "exit=$?"`
Expected: 打印一行 JSON `{"ok": false, "error": "either --list or --virtual-path is required"}`，exit=1。

- [ ] **Step 7: Commit**

```bash
git add docker/hermes/skills/cloud/cloud_publish/download_cli.py \
        docker/hermes/skills/cloud/setup.py \
        docker/hermes/skills/cloud/tests/test_download_cli.py
git commit -m "feat(cloud): cloud-download CLI (--list / --virtual-path) + setup entry point"
```

---

## Task 8: SKILL.md 文档化 cloud-download

**Files:**
- Modify: `docker/hermes/skills/cloud/SKILL.md`

- [ ] **Step 1: 更新 frontmatter description + 追加 cloud-download 段**

把 frontmatter 的 `description` 改为同时覆盖发布与下载：

```yaml
description: 管理用户的 laifu 云盘。cloud-publish 把容器内文件发布到云盘（用户在网页"文件"app 可见）；cloud-download 列出并下载用户在网页端上传到云盘的文件。当用户说"保存到云盘/发布"用 cloud-publish；当用户说"用我上传的文件/云盘里的 X 文件/我传了个文件给你"用 cloud-download 先 --list 再按 virtual-path 下载。
```

在文件末尾（退出码段之后）追加：

```markdown

---

# cloud-download

列出并下载用户在网页端上传到云盘的文件，供 agent 在容器内使用。

## 何时使用

- 用户说"用我刚上传的文件""云盘里的 data.csv""我传了个文件给你处理"等
- 典型流程：先 `--list` 看有哪些文件，再用 `--virtual-path` 下载到本地处理

## 用法

```bash
# 列出云盘所有文件（扁平递归），可选 --prefix 收窄
cloud-download --list
cloud-download --list --prefix datasets/

# 下载单个文件到本地
cloud-download --virtual-path datasets/sales.csv --output /home/hermes/work/sales.csv
```

## 参数

| 参数 | 说明 |
|---|---|
| `--list` | 列出文件，输出 `{"ok":true,"files":[{virtual_path,size,last_modified,content_type,source,title}]}` |
| `--prefix PFX` | 配合 `--list`，只列该虚拟前缀下的文件，如 `reports/` |
| `--virtual-path PATH` | 要下载的云盘路径 |
| `--output FILE` | 本地保存路径（与 `--virtual-path` 配合，必填） |

`source` 字段：`web`=用户网页上传，`agent`=agent 之前发布。

## 输出与退出码

stdout 一行 JSON。退出码：0=成功，1=参数错误，2=鉴权失败，3=网络/下载失败（含文件不存在），4=其他。
```

- [ ] **Step 2: Commit**

```bash
git add docker/hermes/skills/cloud/SKILL.md
git commit -m "docs(cloud): SKILL.md 文档化 cloud-download + 更新 description"
```

> 注：entrypoint 软链的是整个 `cloud` skill 目录，`cloud-download` 与 `cloud-publish` 同包同目录，`cloud` entitlement 启用时自动一并带上，无需改 symlink 逻辑。

---

## Task 9: Web — `api.cloudUpload`（XHR 带进度）

**Files:**
- Modify: `apps/web/src/lib/api.ts`（末尾）
- Test: `apps/web/test/cloudUpload.test.ts`

- [ ] **Step 1: 写失败测试（mock XMLHttpRequest）**

创建 `apps/web/test/cloudUpload.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cloudUpload } from '../src/lib/api.js';

class FakeXHR {
  static instances: FakeXHR[] = [];
  upload = { onprogress: null as any };
  onload: any = null;
  onerror: any = null;
  status = 0;
  responseText = '';
  method = ''; url = '';
  constructor() { FakeXHR.instances.push(this); }
  open(m: string, u: string) { this.method = m; this.url = u; }
  setRequestHeader() {}
  send(_body: any) {}
  withCredentials = false;
  // helpers
  emitProgress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
  finish(status: number, body: any) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}

describe('cloudUpload', () => {
  beforeEach(() => { FakeXHR.instances = []; (globalThis as any).XMLHttpRequest = FakeXHR as any; });
  afterEach(() => { delete (globalThis as any).XMLHttpRequest; });

  it('POSTs multipart to /api/cloud/upload and resolves on 200', async () => {
    const file = new File(['a,b,c'], 'data.csv', { type: 'text/csv' });
    const p = cloudUpload(file, 'inbox/data.csv', { title: '数据' });
    const xhr = FakeXHR.instances[0];
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('/api/cloud/upload');
    xhr.finish(200, { ok: true, virtual_path: 'inbox/data.csv', size: 5, last_modified: 'x' });
    await expect(p).resolves.toMatchObject({ ok: true, virtual_path: 'inbox/data.csv' });
  });

  it('reports progress fractions', async () => {
    const file = new File(['x'], 'x.txt', { type: 'text/plain' });
    const seen: number[] = [];
    const p = cloudUpload(file, 'x.txt', { onProgress: (f) => seen.push(f) });
    const xhr = FakeXHR.instances[0];
    xhr.emitProgress(50, 100);
    xhr.emitProgress(100, 100);
    xhr.finish(200, { ok: true, virtual_path: 'x.txt', size: 1, last_modified: 'x' });
    await p;
    expect(seen).toEqual([0.5, 1]);
  });

  it('rejects on non-2xx with status', async () => {
    const file = new File(['x'], 'x.txt', { type: 'text/plain' });
    const p = cloudUpload(file, 'x.txt');
    const xhr = FakeXHR.instances[0];
    xhr.finish(413, { error: 'file too large (10MB limit)' });
    await expect(p).rejects.toThrow(/413|too large/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @lingxi/web test -- cloudUpload.test.ts`
Expected: FAIL（`cloudUpload` 未导出）。

- [ ] **Step 3: 实现 `cloudUpload`**

在 `api.ts` 末尾追加（同时 import 新增的响应类型）：

```ts
import type { CloudUploadResponse } from '@lingxi/shared';

export interface CloudUploadOpts {
  title?: string;
  onProgress?: (fraction: number) => void;  // 0..1
}

/**
 * 上传文件到云盘（multipart 走 gateway 代理）。
 * 用 XMLHttpRequest 以拿到上传进度（fetch 不支持 upload progress）。
 */
export const cloudUpload = (
  file: File,
  virtualPath: string,
  opts: CloudUploadOpts = {},
): Promise<CloudUploadResponse> => {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file);
    form.append('virtual_path', virtualPath);
    if (opts.title) form.append('title', opts.title);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/cloud/upload');
    xhr.withCredentials = true;
    if (opts.onProgress) {
      xhr.upload.onprogress = (e: ProgressEvent) => {
        if (e.lengthComputable) opts.onProgress!(e.loaded / e.total);
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText) as CloudUploadResponse); }
        catch { reject(new Error('invalid upload response')); }
      } else {
        let msg = `upload → ${xhr.status}`;
        try { const b = JSON.parse(xhr.responseText); if (b?.error) msg = `${xhr.status}: ${b.error}`; } catch { /* ignore */ }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error('upload network error'));
    xhr.send(form);
  });
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @lingxi/web test -- cloudUpload.test.ts`
Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/api.ts apps/web/test/cloudUpload.test.ts
git commit -m "feat(web): api.cloudUpload (XHR multipart + 进度)"
```

---

## Task 10: Web — types & utils（source + 预览判断 + 角标）

**Files:**
- Modify: `apps/web/src/apps/files/types.ts`
- Modify: `apps/web/src/apps/files/utils.ts`
- Test: `apps/web/test/filesUtils.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/web/test/filesUtils.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { isPreviewable, sourceBadge } from '../src/apps/files/utils.js';

describe('isPreviewable', () => {
  it('true for pdf by content-type', () => {
    expect(isPreviewable({ content_type: 'application/pdf', virtual_path: 'a.pdf' })).toBe(true);
  });
  it('true for image by content-type', () => {
    expect(isPreviewable({ content_type: 'image/png', virtual_path: 'a.png' })).toBe(true);
  });
  it('true for pdf by extension when content-type null', () => {
    expect(isPreviewable({ content_type: null, virtual_path: 'a.pdf' })).toBe(true);
  });
  it('false for csv', () => {
    expect(isPreviewable({ content_type: 'text/csv', virtual_path: 'a.csv' })).toBe(false);
  });
});

describe('sourceBadge', () => {
  it('returns a marker for web source', () => {
    expect(sourceBadge('web')).not.toBe('');
  });
  it('returns empty for agent source', () => {
    expect(sourceBadge('agent')).toBe('');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @lingxi/web test -- filesUtils.test.ts`
Expected: FAIL（函数未导出）。

- [ ] **Step 3: 加 `FileItem.source` + utils 函数**

`types.ts` 的 `FileItem` 末尾加字段：

```ts
export interface FileItem {
  virtual_path: string;          // relative to root
  size: number;
  last_modified: string;
  content_type: string | null;
  title: string;                 // decoded UTF-8
  session_id: string | null;
  source: 'web' | 'agent';       // 来源：web 上传 or agent 发布
}
```

`utils.ts` 末尾追加：

```ts
export function isPreviewable(file: { content_type: string | null; virtual_path: string }): boolean {
  const ct = file.content_type ?? '';
  if (ct === 'application/pdf' || ct.startsWith('image/')) return true;
  const ext = file.virtual_path.toLowerCase().split('.').pop() ?? '';
  return ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext);
}

/** web 上传的文件返回一个小角标字符，agent 产出的返回空串。 */
export function sourceBadge(source: 'web' | 'agent'): string {
  return source === 'web' ? '↥' : '';
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @lingxi/web test -- filesUtils.test.ts`
Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/apps/files/types.ts apps/web/src/apps/files/utils.ts apps/web/test/filesUtils.test.ts
git commit -m "feat(web): FileItem.source + isPreviewable + sourceBadge"
```

---

## Task 11: Web — FileList 选中/激活/角标改版

**Files:**
- Modify: `apps/web/src/apps/files/FileList.tsx`
- Test: `apps/web/test/FileList.test.tsx`（替换旧契约）

- [ ] **Step 1: 重写 FileList 测试（新契约：选中 + 双击激活 + 角标）**

把 `apps/web/test/FileList.test.tsx` 整个替换为：

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FileList } from '../src/apps/files/FileList.js';
import type { FileItem } from '../src/apps/files/types.js';

const mkFile = (over: Partial<FileItem> = {}): FileItem => ({
  virtual_path: 'hello.pdf', size: 100, last_modified: new Date().toISOString(),
  content_type: 'application/pdf', title: 'Hello', session_id: null, source: 'agent', ...over,
});

function renderList(props: Partial<React.ComponentProps<typeof FileList>> = {}) {
  return render(
    <FileList
      folders={props.folders ?? []}
      files={props.files ?? []}
      selected={props.selected ?? new Set()}
      onOpenFolder={props.onOpenFolder ?? vi.fn()}
      onSelectFile={props.onSelectFile ?? vi.fn()}
      onActivateFile={props.onActivateFile ?? vi.fn()}
    />
  );
}

describe('FileList', () => {
  it('double-click folder triggers onOpenFolder', () => {
    const onOpenFolder = vi.fn();
    renderList({ folders: [{ virtual_path: 'reports/' }], onOpenFolder });
    fireEvent.doubleClick(screen.getByTestId('folder-row-reports/'));
    expect(onOpenFolder).toHaveBeenCalledWith('reports/');
  });

  it('single-click file triggers onSelectFile with path + modifiers', () => {
    const onSelectFile = vi.fn();
    renderList({ files: [mkFile()], onSelectFile });
    fireEvent.click(screen.getByTestId('file-row-hello.pdf'));
    expect(onSelectFile).toHaveBeenCalled();
    expect(onSelectFile.mock.calls[0][0]).toBe('hello.pdf');
  });

  it('double-click file triggers onActivateFile', () => {
    const onActivateFile = vi.fn();
    const f = mkFile();
    renderList({ files: [f], onActivateFile });
    fireEvent.doubleClick(screen.getByTestId('file-row-hello.pdf'));
    expect(onActivateFile).toHaveBeenCalledWith(f);
  });

  it('selected row gets aria-selected', () => {
    renderList({ files: [mkFile()], selected: new Set(['hello.pdf']) });
    expect(screen.getByTestId('file-row-hello.pdf')).toHaveAttribute('aria-selected', 'true');
  });

  it('web-source file shows ↥ badge; agent file does not', () => {
    renderList({ files: [mkFile({ virtual_path: 'up.csv', title: 'Up', source: 'web', content_type: 'text/csv' })] });
    expect(screen.getByTestId('file-row-up.csv').textContent).toContain('↥');
  });

  it('shows empty message when both lists empty', () => {
    renderList({});
    expect(screen.getByText(/还没有文件/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @lingxi/web test -- FileList.test.tsx`
Expected: FAIL（props 不匹配 / 未渲染 aria-selected / 无角标）。

- [ ] **Step 3: 重写 FileList.tsx**

整个替换 `FileList.tsx`：

```tsx
import type { FolderItem, FileItem } from './types.js';
import { fileIcon, formatSize, formatTime, basename, sourceBadge } from './utils.js';

interface Props {
  folders: FolderItem[];
  files: FileItem[];
  selected: Set<string>;
  onOpenFolder: (path: string) => void;
  onSelectFile: (path: string, e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => void;
  onActivateFile: (file: FileItem) => void;
  emptyMessage?: string;
}

export const FileList = ({ folders, files, selected, onOpenFolder, onSelectFile, onActivateFile, emptyMessage }: Props) => {
  if (folders.length === 0 && files.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 13 }}>
        {emptyMessage ?? '还没有文件 · 让助理把成果发布到云盘，或点上传'}
      </div>
    );
  }
  return (
    <div style={{ flex: 1, overflow: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ position: 'sticky', top: 0, background: 'var(--surface)', textAlign: 'left' }}>
            <th style={{ padding: '8px 12px', fontWeight: 500, color: 'var(--muted)' }}>名称</th>
            <th style={{ padding: '8px 12px', fontWeight: 500, color: 'var(--muted)', width: 100 }}>修改时间</th>
            <th style={{ padding: '8px 12px', fontWeight: 500, color: 'var(--muted)', width: 80 }}>大小</th>
          </tr>
        </thead>
        <tbody>
          {folders.map((f) => (
            <tr
              key={f.virtual_path}
              data-testid={`folder-row-${f.virtual_path}`}
              onDoubleClick={() => onOpenFolder(f.virtual_path)}
              style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)' }}
            >
              <td style={{ padding: '6px 12px' }}>📁 {basename(f.virtual_path)}</td>
              <td style={{ padding: '6px 12px', color: 'var(--muted)' }}>—</td>
              <td style={{ padding: '6px 12px', color: 'var(--muted)' }}>—</td>
            </tr>
          ))}
          {files.map((f) => {
            const isSel = selected.has(f.virtual_path);
            const badge = sourceBadge(f.source);
            return (
              <tr
                key={f.virtual_path}
                data-testid={`file-row-${f.virtual_path}`}
                aria-selected={isSel}
                onClick={(e) => onSelectFile(f.virtual_path, { metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey })}
                onDoubleClick={() => onActivateFile(f)}
                style={{
                  cursor: 'pointer',
                  borderBottom: '1px solid var(--border)',
                  background: isSel ? 'var(--accent-soft, rgba(0,120,255,0.12))' : 'transparent',
                  userSelect: 'none',
                }}
              >
                <td style={{ padding: '6px 12px' }}>
                  {fileIcon(f.virtual_path)} {f.title}
                  {badge && <span title="网页上传" style={{ marginLeft: 6, color: 'var(--muted)' }}>{badge}</span>}
                </td>
                <td style={{ padding: '6px 12px', color: 'var(--muted)' }}>{formatTime(f.last_modified)}</td>
                <td style={{ padding: '6px 12px', color: 'var(--muted)' }}>{formatSize(f.size)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @lingxi/web test -- FileList.test.tsx`
Expected: 全 PASS。（FilesApp.test.tsx 此时可能因 props 变化暂时失败——Task 13 修复。）

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/apps/files/FileList.tsx apps/web/test/FileList.test.tsx
git commit -m "feat(web): FileList 选中高亮/单击选中/双击激活/source 角标"
```

---

## Task 12: Web — Preview 预览 modal

**Files:**
- Create: `apps/web/src/apps/files/Preview.tsx`
- Test: `apps/web/test/Preview.test.tsx`

- [ ] **Step 1: 写失败测试**

创建 `apps/web/test/Preview.test.tsx`：

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Preview } from '../src/apps/files/Preview.js';
import type { FileItem } from '../src/apps/files/types.js';

const mkFile = (over: Partial<FileItem> = {}): FileItem => ({
  virtual_path: 'a.pdf', size: 1, last_modified: 'x', content_type: 'application/pdf',
  title: 'A', session_id: null, source: 'agent', ...over,
});

describe('Preview', () => {
  it('renders an iframe for pdf pointing at inline download url', () => {
    render(<Preview file={mkFile()} onClose={vi.fn()} />);
    const frame = screen.getByTitle('A') as HTMLIFrameElement;
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('src')).toContain('/api/cloud/download?path=a.pdf');
  });

  it('renders an img for image', () => {
    render(<Preview file={mkFile({ virtual_path: 'p.png', content_type: 'image/png', title: 'P' })} onClose={vi.fn()} />);
    const img = screen.getByAltText('P') as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
    expect(img.getAttribute('src')).toContain('/api/cloud/download?path=p.png');
  });

  it('calls onClose on Escape and on backdrop click', () => {
    const onClose = vi.fn();
    render(<Preview file={mkFile()} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('preview-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @lingxi/web test -- Preview.test.tsx`
Expected: FAIL（`Preview` 未定义）。

- [ ] **Step 3: 实现 Preview.tsx**

```tsx
import { useEffect } from 'react';
import type { FileItem } from './types.js';
import * as api from '../../lib/api.js';

interface Props {
  file: FileItem;
  onClose: () => void;
}

export const Preview = ({ file, onClose }: Props) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const url = api.cloudDownloadUrl(file.virtual_path, 'inline');
  const ct = file.content_type ?? '';
  const isImage = ct.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(file.virtual_path);

  return (
    <div
      data-testid="preview-backdrop"
      onClick={onClose}
      style={{
        position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--surface)', width: '80%', height: '85%', borderRadius: 8, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontWeight: 600 }}>{file.title}</span>
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={() => window.open(api.cloudDownloadUrl(file.virtual_path, 'attachment'), '_blank')} style={{ marginRight: 8 }}>下载</button>
          <button className="btn" onClick={onClose}>关闭</button>
        </div>
        <div style={{ flex: 1, background: '#222' }}>
          {isImage
            ? <img alt={file.title} src={url} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
            : <iframe title={file.title} src={url} style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }} />}
        </div>
      </div>
    </div>
  );
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @lingxi/web test -- Preview.test.tsx`
Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/apps/files/Preview.tsx apps/web/test/Preview.test.tsx
git commit -m "feat(web): Preview 预览 modal (PDF iframe / 图片 img, ESC+点外关闭)"
```

---

## Task 13: Web — PathBar 工具栏（上传 / 预览 / 下载）

**Files:**
- Modify: `apps/web/src/apps/files/PathBar.tsx`
- Test: `apps/web/test/PathBar.test.tsx`

- [ ] **Step 1: 写失败测试**

创建 `apps/web/test/PathBar.test.tsx`：

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PathBar } from '../src/apps/files/PathBar.js';

function renderBar(props: Partial<React.ComponentProps<typeof PathBar>> = {}) {
  return render(
    <PathBar
      currentPath={props.currentPath ?? ''}
      selectedCount={props.selectedCount ?? 0}
      canPreview={props.canPreview ?? false}
      onNavigate={props.onNavigate ?? vi.fn()}
      onRefresh={props.onRefresh ?? vi.fn()}
      onUploadClick={props.onUploadClick ?? vi.fn()}
      onPreview={props.onPreview ?? vi.fn()}
      onDownload={props.onDownload ?? vi.fn()}
    />
  );
}

describe('PathBar', () => {
  it('upload button always visible and clickable', () => {
    const onUploadClick = vi.fn();
    renderBar({ onUploadClick });
    fireEvent.click(screen.getByText('上传'));
    expect(onUploadClick).toHaveBeenCalled();
  });

  it('download button hidden when nothing selected', () => {
    renderBar({ selectedCount: 0 });
    expect(screen.queryByText('下载')).not.toBeInTheDocument();
  });

  it('download button shown and calls onDownload when ≥1 selected', () => {
    const onDownload = vi.fn();
    renderBar({ selectedCount: 2, onDownload });
    fireEvent.click(screen.getByText('下载'));
    expect(onDownload).toHaveBeenCalled();
  });

  it('preview button only when exactly 1 selected and canPreview', () => {
    const onPreview = vi.fn();
    const { rerender } = render(
      <PathBar currentPath="" selectedCount={2} canPreview={true}
        onNavigate={vi.fn()} onRefresh={vi.fn()} onUploadClick={vi.fn()} onPreview={onPreview} onDownload={vi.fn()} />
    );
    expect(screen.queryByText('预览')).not.toBeInTheDocument(); // 多选不给预览
    rerender(
      <PathBar currentPath="" selectedCount={1} canPreview={true}
        onNavigate={vi.fn()} onRefresh={vi.fn()} onUploadClick={vi.fn()} onPreview={onPreview} onDownload={vi.fn()} />
    );
    fireEvent.click(screen.getByText('预览'));
    expect(onPreview).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @lingxi/web test -- PathBar.test.tsx`
Expected: FAIL（PathBar 不接受新 props / 无按钮）。

- [ ] **Step 3: 重写 PathBar.tsx**

```tsx
import { IconReload } from '../../lib/icons.js';

interface Props {
  currentPath: string;
  selectedCount: number;
  canPreview: boolean;
  onNavigate: (path: string) => void;
  onRefresh: () => void;
  onUploadClick: () => void;
  onPreview: () => void;
  onDownload: () => void;
}

export const PathBar = ({ currentPath, selectedCount, canPreview, onNavigate, onRefresh, onUploadClick, onPreview, onDownload }: Props) => {
  const segments = currentPath.split('/').filter(Boolean);
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
      <button
        onClick={() => onNavigate('')}
        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px', fontWeight: 600 }}
      >
        我的云盘
      </button>
      {segments.map((seg, i) => {
        const sub = segments.slice(0, i + 1).join('/') + '/';
        return (
          <span key={sub} style={{ display: 'flex', alignItems: 'center' }}>
            <span style={{ margin: '0 4px', color: 'var(--muted)' }}>/</span>
            <button
              onClick={() => onNavigate(sub)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px' }}
            >
              {seg}
            </button>
          </span>
        );
      })}
      <div style={{ flex: 1 }} />
      {selectedCount === 1 && canPreview && (
        <button className="btn" onClick={onPreview} style={{ marginRight: 8 }}>预览</button>
      )}
      {selectedCount >= 1 && (
        <button className="btn" onClick={onDownload} style={{ marginRight: 8 }}>下载{selectedCount > 1 ? `(${selectedCount})` : ''}</button>
      )}
      <button className="btn" onClick={onUploadClick} style={{ marginRight: 8 }}>上传</button>
      <button
        title="刷新"
        onClick={onRefresh}
        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}
      >
        <IconReload size={16} />
      </button>
    </div>
  );
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @lingxi/web test -- PathBar.test.tsx`
Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/apps/files/PathBar.tsx apps/web/test/PathBar.test.tsx
git commit -m "feat(web): PathBar 工具栏 (上传/预览/下载, 按选中状态显隐)"
```

---

## Task 14: Web — UploadController（按钮入口 + 拖拽 + 冲突汇总 + 进度）

**Files:**
- Create: `apps/web/src/apps/files/UploadController.tsx`
- Test: `apps/web/test/UploadController.test.tsx`

> 设计：`UploadController` 是一个无可见布局的受控组件，暴露命令式上传逻辑。父组件（FilesApp）传入 `currentPath`、`existingNames`（当前文件夹已有的文件名集合）、`onUploaded`（成功后刷新）。它内部管理：隐藏 `<input type=file multiple>`、冲突汇总 modal、进度列表。父组件通过 `fileInputRef` 点击触发选择，并把拖拽事件转发进来。为可测试，核心决策逻辑（冲突检测）抽成纯函数 `splitConflicts`。

- [ ] **Step 1: 写失败测试**

创建 `apps/web/test/UploadController.test.tsx`：

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { UploadController, splitConflicts, type UploadHandle } from '../src/apps/files/UploadController.js';

vi.mock('../src/lib/api.js', () => ({
  cloudUpload: vi.fn(),
}));
import * as api from '../src/lib/api.js';

describe('splitConflicts', () => {
  it('separates conflicting from fresh by virtual_path', () => {
    const { conflicts, fresh } = splitConflicts(
      [{ name: 'a.csv' }, { name: 'b.csv' }] as File[],
      'inbox/',
      new Set(['inbox/a.csv']),
    );
    expect(conflicts.map(c => c.name)).toEqual(['a.csv']);
    expect(fresh.map(c => c.name)).toEqual(['b.csv']);
  });
});

describe('UploadController', () => {
  beforeEach(() => { vi.mocked(api.cloudUpload).mockReset(); vi.mocked(api.cloudUpload).mockResolvedValue({ ok: true, virtual_path: 'x', size: 1, last_modified: 'x' }); });

  function setup(existing: string[] = []) {
    const ref = createRef<UploadHandle>();
    const onUploaded = vi.fn();
    render(
      <UploadController
        ref={ref}
        currentPath="inbox/"
        existingPaths={new Set(existing)}
        onUploaded={onUploaded}
      />
    );
    return { ref, onUploaded };
  }

  it('uploads fresh files directly (no conflict modal)', async () => {
    const { ref, onUploaded } = setup([]);
    const file = new File(['x'], 'new.csv', { type: 'text/csv' });
    ref.current!.uploadFiles([file]);
    await waitFor(() => expect(api.cloudUpload).toHaveBeenCalledWith(file, 'inbox/new.csv', expect.any(Object)));
    await waitFor(() => expect(onUploaded).toHaveBeenCalled());
  });

  it('shows conflict modal and "全部覆盖" overwrites', async () => {
    const { ref } = setup(['inbox/dup.csv']);
    const file = new File(['x'], 'dup.csv', { type: 'text/csv' });
    ref.current!.uploadFiles([file]);
    await waitFor(() => expect(screen.getByText(/已存在/)).toBeInTheDocument());
    fireEvent.click(screen.getByText('全部覆盖'));
    await waitFor(() => expect(api.cloudUpload).toHaveBeenCalledWith(file, 'inbox/dup.csv', expect.any(Object)));
  });

  it('"跳过已存在" does not upload the conflicting file', async () => {
    const { ref } = setup(['inbox/dup.csv']);
    const dup = new File(['x'], 'dup.csv', { type: 'text/csv' });
    const fresh = new File(['y'], 'ok.csv', { type: 'text/csv' });
    ref.current!.uploadFiles([dup, fresh]);
    await waitFor(() => expect(screen.getByText(/已存在/)).toBeInTheDocument());
    fireEvent.click(screen.getByText('跳过已存在'));
    await waitFor(() => expect(api.cloudUpload).toHaveBeenCalledWith(fresh, 'inbox/ok.csv', expect.any(Object)));
    expect(api.cloudUpload).not.toHaveBeenCalledWith(dup, 'inbox/dup.csv', expect.any(Object));
  });

  it('"取消" uploads nothing', async () => {
    const { ref } = setup(['inbox/dup.csv']);
    const dup = new File(['x'], 'dup.csv', { type: 'text/csv' });
    ref.current!.uploadFiles([dup]);
    await waitFor(() => expect(screen.getByText(/已存在/)).toBeInTheDocument());
    fireEvent.click(screen.getByText('取消'));
    expect(api.cloudUpload).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @lingxi/web test -- UploadController.test.tsx`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 UploadController.tsx**

```tsx
import { forwardRef, useImperativeHandle, useState } from 'react';
import * as api from '../../lib/api.js';

export interface UploadHandle {
  uploadFiles: (files: File[]) => void;
}

interface Props {
  currentPath: string;             // 形如 '' 或 'inbox/'
  existingPaths: Set<string>;      // 当前云盘已有文件的 virtual_path 全集
  onUploaded: () => void;          // 任一文件成功后触发（用于刷新）
}

interface ProgressItem { name: string; fraction: number; error?: string; }

const MAX_CONCURRENCY = 3;

/** 把待传文件按是否与现有 virtual_path 冲突拆成两组（纯函数，便于单测）。 */
export function splitConflicts(files: File[], currentPath: string, existingPaths: Set<string>) {
  const conflicts: File[] = [];
  const fresh: File[] = [];
  for (const f of files) {
    const vp = `${currentPath}${f.name}`;
    (existingPaths.has(vp) ? conflicts : fresh).push(f);
  }
  return { conflicts, fresh };
}

async function runPool(files: File[], currentPath: string, onProgress: (name: string, frac: number) => void, onError: (name: string, msg: string) => void) {
  let idx = 0;
  const worker = async () => {
    while (idx < files.length) {
      const f = files[idx++];
      const vp = `${currentPath}${f.name}`;
      try {
        await api.cloudUpload(f, vp, { onProgress: (frac) => onProgress(f.name, frac) });
        onProgress(f.name, 1);
      } catch (err) {
        onError(f.name, err instanceof Error ? err.message : String(err));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, files.length) }, worker));
}

export const UploadController = forwardRef<UploadHandle, Props>(({ currentPath, existingPaths, onUploaded }, ref) => {
  const [pendingConflicts, setPendingConflicts] = useState<File[] | null>(null);
  const [pendingFresh, setPendingFresh] = useState<File[]>([]);
  const [progress, setProgress] = useState<ProgressItem[]>([]);

  const doUpload = async (files: File[]) => {
    if (files.length === 0) return;
    setProgress(files.map((f) => ({ name: f.name, fraction: 0 })));
    await runPool(
      files,
      currentPath,
      (name, frac) => setProgress((p) => p.map((it) => it.name === name ? { ...it, fraction: frac } : it)),
      (name, msg) => setProgress((p) => p.map((it) => it.name === name ? { ...it, error: msg } : it)),
    );
    onUploaded();
    // 让用户看到 100% / 错误后清空（保留错误项）
    setProgress((p) => p.filter((it) => it.error));
  };

  const uploadFiles = (files: File[]) => {
    const { conflicts, fresh } = splitConflicts(files, currentPath, existingPaths);
    if (conflicts.length > 0) {
      setPendingConflicts(conflicts);
      setPendingFresh(fresh);
    } else {
      void doUpload(fresh);
    }
  };

  useImperativeHandle(ref, () => ({ uploadFiles }));

  const resolveConflict = (mode: 'overwrite' | 'skip' | 'cancel') => {
    const conflicts = pendingConflicts ?? [];
    const fresh = pendingFresh;
    setPendingConflicts(null);
    setPendingFresh([]);
    if (mode === 'cancel') return;
    const toUpload = mode === 'overwrite' ? [...fresh, ...conflicts] : fresh;
    void doUpload(toUpload);
  };

  return (
    <>
      {pendingConflicts && pendingConflicts.length > 0 && (
        <div
          style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 20 }}
        >
          <div style={{ background: 'var(--surface)', padding: 20, borderRadius: 8, maxWidth: 420 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>{pendingConflicts.length} 个文件已存在</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', maxHeight: 160, overflow: 'auto', marginBottom: 12 }}>
              {pendingConflicts.map((f) => <div key={f.name}>{f.name}</div>)}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn" onClick={() => resolveConflict('cancel')}>取消</button>
              <button className="btn" onClick={() => resolveConflict('skip')}>跳过已存在</button>
              <button className="btn" onClick={() => resolveConflict('overwrite')}>全部覆盖</button>
            </div>
          </div>
        </div>
      )}
      {progress.length > 0 && (
        <div style={{ position: 'absolute', bottom: 12, right: 12, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, minWidth: 220, zIndex: 15 }}>
          {progress.map((it) => (
            <div key={it.name} style={{ fontSize: 12, marginBottom: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{it.name}</span>
                <span style={{ color: it.error ? 'var(--err,#c00)' : 'var(--muted)' }}>
                  {it.error ? '失败' : `${Math.round(it.fraction * 100)}%`}
                </span>
              </div>
              {it.error && <div style={{ color: 'var(--err,#c00)' }}>{it.error}</div>}
            </div>
          ))}
        </div>
      )}
    </>
  );
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @lingxi/web test -- UploadController.test.tsx`
Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/apps/files/UploadController.tsx apps/web/test/UploadController.test.tsx
git commit -m "feat(web): UploadController (并发上传 + 冲突汇总确认 + 进度)"
```

---

## Task 15: Web — FilesApp 串起选中 / 预览 / 上传 / 拖拽

**Files:**
- Modify: `apps/web/src/apps/files/FilesApp.tsx`
- Test: `apps/web/test/FilesApp.test.tsx`（更新到新交互）

- [ ] **Step 1: 更新 FilesApp 测试**

把 `apps/web/test/FilesApp.test.tsx` 整体替换为：

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { FilesApp } from '../src/apps/files/FilesApp.js';

vi.mock('../src/lib/api.js', () => ({
  cloudList: vi.fn(),
  cloudUpload: vi.fn(),
  cloudDownloadUrl: (path: string, dispose: string) => `/api/cloud/download?path=${path}&dispose=${dispose}`,
}));
import * as api from '../src/lib/api.js';

const fileMeta = (over = {}) => ({ title: 'Hello', session_id: 'main', published_at: null, tool_version: null, description: null, tags: null, source: 'agent', ...over });

describe('FilesApp', () => {
  beforeEach(() => { vi.mocked(api.cloudList).mockReset(); });

  it('loads root list on mount and renders files', async () => {
    vi.mocked(api.cloudList).mockResolvedValue({
      folders: [{ virtual_path: 'reports/' }],
      files: [{ virtual_path: 'hello.pdf', size: 1024, last_modified: new Date().toISOString(), content_type: 'application/pdf', metadata: fileMeta() }],
    });
    render(<FilesApp />);
    await waitFor(() => expect(screen.getByText(/reports/)).toBeInTheDocument());
    expect(screen.getByText(/Hello/)).toBeInTheDocument();
  });

  it('does not show 加载中 placeholder', async () => {
    const pending = new Promise<any>(() => {});
    vi.mocked(api.cloudList).mockReturnValue(pending);
    render(<FilesApp />);
    expect(screen.queryByText(/加载中/)).not.toBeInTheDocument();
    expect(screen.getByText(/还没有文件/)).toBeInTheDocument();
  });

  it('shows download button after selecting a file', async () => {
    vi.mocked(api.cloudList).mockResolvedValue({
      folders: [],
      files: [{ virtual_path: 'hello.pdf', size: 1024, last_modified: new Date().toISOString(), content_type: 'application/pdf', metadata: fileMeta() }],
    });
    render(<FilesApp />);
    await waitFor(() => expect(screen.getByTestId('file-row-hello.pdf')).toBeInTheDocument());
    expect(screen.queryByText('下载')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('file-row-hello.pdf'));
    expect(screen.getByText('下载')).toBeInTheDocument();
    expect(screen.getByText('预览')).toBeInTheDocument(); // pdf 可预览
  });

  it('double-click pdf opens preview modal', async () => {
    vi.mocked(api.cloudList).mockResolvedValue({
      folders: [],
      files: [{ virtual_path: 'hello.pdf', size: 1024, last_modified: new Date().toISOString(), content_type: 'application/pdf', metadata: fileMeta() }],
    });
    render(<FilesApp />);
    await waitFor(() => expect(screen.getByTestId('file-row-hello.pdf')).toBeInTheDocument());
    fireEvent.doubleClick(screen.getByTestId('file-row-hello.pdf'));
    expect(screen.getByTitle('Hello')).toBeInTheDocument(); // Preview iframe title
  });

  it('shows error and retry button when load fails', async () => {
    vi.mocked(api.cloudList).mockRejectedValue(new Error('boom'));
    render(<FilesApp />);
    await waitFor(() => expect(screen.getByText(/加载失败/)).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByText('重试')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @lingxi/web test -- FilesApp.test.tsx`
Expected: FAIL（无下载/预览按钮、无 Preview）。

- [ ] **Step 3: 重写 FilesApp.tsx**

```tsx
import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import * as api from '../../lib/api.js';
import type { FolderItem, FileItem } from './types.js';
import { isPreviewable } from './utils.js';
import { PathBar } from './PathBar.js';
import { Sidebar } from './Sidebar.js';
import { FileList } from './FileList.js';
import { Preview } from './Preview.js';
import { UploadController, type UploadHandle } from './UploadController.js';

export const FilesApp = () => {
  const [currentPath, setCurrentPath] = useState('');
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<FileItem | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploaderRef = useRef<UploadHandle>(null);

  const load = useCallback(async (path: string) => {
    setError(null);
    setSelected(new Set());
    try {
      const data = await api.cloudList(path);
      setFolders(data.folders);
      setFiles(data.files.map((f) => ({
        virtual_path: f.virtual_path,
        size: f.size,
        last_modified: f.last_modified,
        content_type: f.content_type,
        title: f.metadata.title,
        session_id: f.metadata.session_id,
        source: f.metadata.source,
      })));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setFolders([]);
      setFiles([]);
    }
  }, []);

  useEffect(() => { load(currentPath).catch(() => {}); }, [currentPath, load]);

  const navigate = (path: string) => setCurrentPath(path);
  const refresh = () => { load(currentPath).catch(() => {}); };

  // 当前文件夹已有的全部 virtual_path（用于上传冲突检测）
  const existingPaths = useMemo(() => new Set(files.map((f) => f.virtual_path)), [files]);

  const fileByPath = useMemo(() => new Map(files.map((f) => [f.virtual_path, f])), [files]);

  const onSelectFile = (path: string, mods: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (mods.metaKey || mods.ctrlKey) {
        next.has(path) ? next.delete(path) : next.add(path);
        return next;
      }
      if (mods.shiftKey && prev.size > 0) {
        // 范围选：从第一个已选到当前
        const order = files.map((f) => f.virtual_path);
        const anchor = order.findIndex((p) => prev.has(p));
        const target = order.indexOf(path);
        const [a, b] = anchor < target ? [anchor, target] : [target, anchor];
        return new Set(order.slice(a, b + 1));
      }
      return new Set([path]);
    });
  };

  const onActivateFile = (file: FileItem) => {
    if (isPreviewable(file)) setPreview(file);
    else setSelected(new Set([file.virtual_path])); // 不可预览：双击=选中
  };

  const selectedFiles = useMemo(() => [...selected].map((p) => fileByPath.get(p)).filter(Boolean) as FileItem[], [selected, fileByPath]);
  const canPreview = selected.size === 1 && selectedFiles.length === 1 && isPreviewable(selectedFiles[0]);

  const onPreview = () => { if (selectedFiles.length === 1) setPreview(selectedFiles[0]); };
  const onDownload = () => {
    for (const f of selectedFiles) {
      window.open(api.cloudDownloadUrl(f.virtual_path, 'attachment'), '_blank');
    }
  };

  const onUploadClick = () => fileInputRef.current?.click();
  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files ? Array.from(e.target.files) : [];
    if (list.length) uploaderRef.current?.uploadFiles(list);
    e.target.value = '';
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const list = e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
    if (list.length) uploaderRef.current?.uploadFiles(list);
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
      <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={onFileInputChange} data-testid="file-input" />
      <PathBar
        currentPath={currentPath}
        selectedCount={selected.size}
        canPreview={canPreview}
        onNavigate={navigate}
        onRefresh={refresh}
        onUploadClick={onUploadClick}
        onPreview={onPreview}
        onDownload={onDownload}
      />
      <div
        style={{ flex: 1, display: 'flex', outline: dragOver ? '2px dashed var(--accent,#08f)' : 'none', outlineOffset: -4 }}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <Sidebar onHome={() => setCurrentPath('')} />
        {error ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <div style={{ color: 'var(--err, #c00)' }}>加载失败：{error}</div>
            <button className="btn" onClick={refresh}>重试</button>
          </div>
        ) : (
          <FileList
            folders={folders}
            files={files}
            selected={selected}
            onOpenFolder={navigate}
            onSelectFile={onSelectFile}
            onActivateFile={onActivateFile}
          />
        )}
      </div>
      <UploadController
        ref={uploaderRef}
        currentPath={currentPath}
        existingPaths={existingPaths}
        onUploaded={refresh}
      />
      {preview && <Preview file={preview} onClose={() => setPreview(null)} />}
    </div>
  );
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @lingxi/web test -- FilesApp.test.tsx`
Expected: 全 PASS。

- [ ] **Step 5: 跑全部 web 测试 + 类型检查**

Run: `pnpm --filter @lingxi/web test && pnpm --filter @lingxi/web exec tsc --noEmit`
Expected: 全 PASS，类型无错误。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/apps/files/FilesApp.tsx apps/web/test/FilesApp.test.tsx
git commit -m "feat(web): FilesApp 串起选中/多选/双击预览/上传/拖拽"
```

---

## Task 16: 全量回归 + 手动端到端验证

**Files:** 无（验证任务）

- [ ] **Step 1: 跑三端全部单测**

```bash
pnpm --filter @lingxi/gateway test
pnpm --filter @lingxi/web test
cd docker/hermes/skills/cloud && python -m pytest -q && cd -
```
Expected: 三处全部 PASS。

- [ ] **Step 2: 类型/构建检查**

```bash
pnpm --filter @lingxi/shared build
pnpm --filter @lingxi/gateway lint
pnpm --filter @lingxi/web exec tsc --noEmit
```
Expected: 全部无错误。

- [ ] **Step 3: 手动端到端（本地，需 gateway + Azurite/真 Blob + 已启用 cloud entitlement）**

> 这一步需要真实环境，无法用单测覆盖（涉及浏览器、容器、Azure）。按下列清单逐项确认：

1. **web 上传**：打开"文件" App → 点 `上传` 选一个 `data.csv` → 列表出现该文件且带 `↥` 角标（source=web）。
2. **同名冲突**：再上传同名 `data.csv` → 弹"1 个文件已存在" → 点 `全部覆盖` → 覆盖成功。
3. **拖拽多文件**：拖入两个文件 → 都上传成功，进度条到 100%。
4. **下载交互**：单击文件 → 行高亮、顶部出现 `[下载]`；PDF/图片单选还出现 `[预览]`。双击 PDF → 预览 modal 打开；ESC 关闭。
5. **批量下载**：Cmd/Ctrl 多选两个文件 → 点 `下载(2)` → 浏览器分别下载两个文件（首次可能提示"允许下载多个文件"）。
6. **agent 下载**：在 hermes 容器内执行
   ```bash
   cloud-download --list
   cloud-download --virtual-path data.csv --output /home/hermes/work/data.csv
   sha256sum /home/hermes/work/data.csv   # 与上传源文件比对一致
   ```
   `--list` 输出含刚上传文件且 `source=web`；下载文件 sha256 与源一致。
7. **agent 产出回看**：容器内 `cloud-publish --file ... --virtual-path out.pdf` → web list 中 `out.pdf` 无 `↥` 角标（source=agent）。

- [ ] **Step 4: 合并准备**

确认 `git status` 干净、所有 commit 已落在 `feat/cloud-drive-upload`。后续走 `superpowers:finishing-a-development-branch` 决定合并/PR。

---

## Self-Review（已对 spec 核对）

- **Spec §三 web 上传流** → Task 3（端点）+ Task 9（api）+ Task 14（UI/冲突/进度）+ Task 15（拖拽/按钮串接）✅
- **Spec §三 agent 下载流（list+download，复用 racwl SAS）** → Task 6（downloader）+ Task 7（CLI）✅
- **Spec §四 `POST /api/cloud/upload` 契约（multer/校验/source=web/413/400/403）** → Task 3 全覆盖 ✅
- **Spec §四 `/list` 透传 source** → Task 2 ✅
- **Spec §四 cloud-download CLI 契约（--list/--virtual-path/--output/退出码）** → Task 7 ✅
- **Spec §五 source=agent（publish）** → Task 5 ✅；**source 角标** → Task 10 + Task 11 ✅
- **Spec §五 下载交互（单击选中/多选/双击预览/工具栏）** → Task 11 + Task 12 + Task 13 + Task 15 ✅
- **Spec §五 预览 modal（PDF iframe/图片 img）** → Task 12 ✅
- **Spec §六 安全（source 服务端写、不暴露 SAS、path 前缀、size 413）** → Task 3 测试覆盖 ✅
- **Spec §七 错误处理（413/400/403/重试/404/SAS 刷新/预览失败）** → Task 3 + Task 6 + Task 12 ✅
- **Spec §八 测试** → 各 Task 内 TDD 步骤 + Task 16 回归与手动 e2e ✅
- **Spec §九 无新表** → 计划无 DB 改动 ✅
- **类型一致性**：`CloudUploadResponse`（Task 1）被 Task 9 引用；`FileItem.source`（Task 10）被 Task 11/15 引用；`splitConflicts`/`UploadHandle`/`uploadFiles`（Task 14）被 Task 15 引用；`isPreviewable`/`sourceBadge`（Task 10）被 Task 11/12/15 引用——命名前后一致 ✅
- **占位符**：无 TBD/TODO，每个代码步骤含完整代码 ✅
