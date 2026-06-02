# Cloud Drive — P4 + P5 Files App + Entitlement UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把云盘的前端做出最小可见 demo —— ManageApp 上有"启用云盘"按钮 + 等待 Modal，启用后 Dock 上动态出现 Files App 图标，Files App 能列云盘内容 + 双击下载文件。这一阶段 P5（启用流程）和 P4（Files App MVP）合并实施。

**Architecture:**
- **EntitlementsContext + useEntitlements hook**：单一数据源，包装 `/api/status` 的 `entitlements_desired` / `entitlements_observed`；ManageApp 启用按钮成功后调 context 的 `refetch()`，触发整个树重新决策（Dock 出图标 / Files App 接通）
- **ManageApp 启用 Modal 状态机**：`idle → posting → polling → ready / failed / timeout`，5s 间隔 poll status，最长 30s
- **Dock 动态渲染**：基础 app（chat / manage）始终显示；条件 app（files）由 `entitlements_observed.includes('cloud')` 控制
- **Files App MVP**：仿 Finder 列表视图；面包屑导航；双击文件夹进入子目录；双击文件触发 `window.open('/api/cloud/download?path=...&dispose=attachment')` 让浏览器跟 302 下载
- **CSS / 样式**：复用现有 inline-style 风格（参考 ManageApp / Window / Dock），不引入新 UI 库

**Tech Stack:**
- 现有 stack：React 19 / vite / vitest + jsdom + RTL（无新依赖）
- 复用 `@lingxi/shared` 已 export 的 contracts（P1 加 EntitlementsList / StatusResponse 扩展；P2 加 CloudListResponse 等）

**Out of scope for P4+P5:**
- 容器侧 cloud-publish CLI → P3（独立，可后做）
- PDF / 图片嵌入预览 → P6
- web 上传 / 删除 / 改名 → 第二迭代
- 真正的"启用后 5-15 秒看到 ready" —— local dev provisioner 是 mock 不会真重启容器并上报 observed；本 plan 在 §端到端手测 段说明如何用 psql 手动 INSERT 模拟容器上报

**Spec reference:** `docs/superpowers/specs/2026-06-01-cloud-drive-design.md` §四（entitlement 流程）+ §七（Web UI Files App + ManageApp）+ §十 P4/P5 行

---

## File Structure

```
新增 — web:
  apps/web/src/lib/entitlements-context.tsx              EntitlementsContext + useEntitlements + provider
  apps/web/test/entitlements-context.test.tsx            hook 行为：refetch / desired vs observed
  apps/web/src/apps/files/FilesApp.tsx                    主体（窗口内容）
  apps/web/src/apps/files/FileList.tsx                    中央文件列表（仿 Finder 列表视图）
  apps/web/src/apps/files/PathBar.tsx                     顶部面包屑 + 刷新
  apps/web/src/apps/files/Sidebar.tsx                     左侧"位置"导航（占位，先只显示"我的云盘"）
  apps/web/src/apps/files/types.ts                        FolderItem / FileItem / 内部 state 类型
  apps/web/src/apps/files/utils.ts                        扩展名 → emoji、size 格式化、时间格式化
  apps/web/test/FilesApp.test.tsx                         加载列表 + 错误显示
  apps/web/test/FileList.test.tsx                         折叠展开 + 双击行为
  apps/web/src/apps/manage/EnableCloudButton.tsx         "启用云盘"按钮 + Modal 状态机
  apps/web/test/EnableCloudButton.test.tsx                Modal 状态变化测试
  apps/web/test/Dock.test.tsx                             entitlements 动态显示 Files

修改:
  apps/web/src/lib/api.ts                                  + cloud list + cloud download URL helper + enable/disable + me/entitlements (web 这边不强用，主要靠 status)
  apps/web/src/App.tsx                                     用 EntitlementsProvider 包 Desktop
  apps/web/src/desktop/Desktop.tsx                         + files app 进 titles/renderApp；entitlements 变化时自动打开 files
  apps/web/src/desktop/Dock.tsx                            + entitlements prop + 条件渲染 files 图标
  apps/web/src/apps/manage/ManageApp.tsx                   + "功能 / 订阅" 区，挂 EnableCloudButton
  apps/web/src/lib/icons.tsx                                + IconFolder + IconDownload (用 lucide-style stroke SVG，跟现有保持一致)
```

每个 src 文件单一职责：

| 文件 | 职责 |
|---|---|
| `entitlements-context.tsx` | 单一数据源：包装 `/api/status` 拉 `entitlements_desired` + `entitlements_observed`，暴露 `useEntitlements()` 给 Dock / Files / ManageApp |
| `EnableCloudButton.tsx` | 启用按钮 + 等待 Modal 状态机（POST enable → poll status → 终态） |
| `FilesApp.tsx` | 主容器：管 `currentPath` state + 调 `api.cloudList(prefix)` + 嵌 PathBar/Sidebar/FileList |
| `FileList.tsx` | 列表渲染：folders + files；双击文件夹 → navigate；双击文件 → 下载 |
| `PathBar.tsx` | 路径面包屑 + 刷新按钮（pure UI，回调上层）|
| `Sidebar.tsx` | 左侧位置导航（MVP 只有"我的云盘" → 跳回根） |
| `types.ts` | 内部 type alias（不同于 `@lingxi/shared` 的 wire type，UI 用的派生类型） |
| `utils.ts` | 纯函数：`fileIcon(ext)`, `formatSize(bytes)`, `formatTime(iso)` |

---

## Task 0: 起步检查

**Files:** 无

- [ ] **Step 1: 分支 + 工作树干净**

Run: `git status && git branch --show-current`
Expected: on `feat/cloud-drive`, clean.

- [ ] **Step 2: P0/P1/P2 都在**

Run: `git log --oneline main..HEAD | head -3`
Expected: top is `51b3dc1 feat(gateway): wire cloud router ...`

- [ ] **Step 3: web baseline**

Run: `pnpm --filter @lingxi/web test 2>&1 | tail -8`
Expected: 17 total, **3 EventSource failures preexisting** (Conversation.tsx — unrelated to cloud)，14 passed。
新加测试时不会修复 EventSource，只要不引入新 fail 即可。

- [ ] **Step 4: gateway tests baseline**

Run: `pnpm --filter @lingxi/gateway test 2>&1 | tail -3`
Expected: 232 total (218 passed + 14 skipped DAO)。

- [ ] **Step 5: shared exports check**

Run: `grep -E "^export" packages/shared/src/contracts.ts | head -20`
Confirm `EntitlementsList`, `EntitlementChangeResponse`, `CloudListResponse`, `CloudFileItem`, `CloudFolderItem`, `StatusResponse`(扩展过的) 都 export 了。

If any missing, BLOCK — that means a previous task didn't land the contract.

---

## Task 1: Web API client extensions

**Files:**
- Modify: `apps/web/src/lib/api.ts`

加：
- `enableCloud()` / `disableCloud()`
- `cloudList(prefix?)` 返回 `CloudListResponse`
- `cloudDownloadUrl(path, dispose)` —— 纯函数，构造下载 URL 给 `window.open` 用，**不发请求**
- 现有 `status()` 不动（P1 已扩展 StatusResponse）

- [ ] **Step 1: Read current api.ts**

Read `apps/web/src/lib/api.ts` to know the current pattern (uses `json` helper, throws `AuthError` on 401).

- [ ] **Step 2: Add types import + new functions**

At the top of `apps/web/src/lib/api.ts`, find the existing `import type { ... } from '@lingxi/shared'` and ADD to it:

```typescript
  EntitlementChangeResponse,
  CloudListResponse,
```

(Insert alphabetically into the existing import list.)

At the END of `apps/web/src/lib/api.ts`, append:

```typescript

// === Cloud Drive (P4+P5) ===

export const enableCloud = (): Promise<EntitlementChangeResponse> =>
  json('/api/entitlements/cloud/enable', { method: 'POST' });

export const disableCloud = (): Promise<EntitlementChangeResponse> =>
  json('/api/entitlements/cloud/disable', { method: 'POST' });

export const cloudList = (prefix = ''): Promise<CloudListResponse> => {
  const q = prefix ? `?prefix=${encodeURIComponent(prefix)}` : '';
  return json(`/api/cloud/list${q}`);
};

/**
 * 构造下载 URL（不发请求）。前端用 `window.open(url)` 让浏览器跟 302 走到 Blob。
 *  dispose='inline' (默认): SAS 不带 rscd，浏览器按 content-type 决定显示/下载
 *  dispose='attachment': SAS 带 rscd，强制下载并用 metadata.title 当文件名
 */
export const cloudDownloadUrl = (path: string, dispose: 'inline' | 'attachment' = 'inline'): string => {
  const params = new URLSearchParams({ path });
  if (dispose === 'attachment') params.set('dispose', 'attachment');
  return `/api/cloud/download?${params.toString()}`;
};
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
pnpm --filter @lingxi/web run lint
```
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/api.ts
git commit -m "feat(web): cloud + entitlements API client wrappers"
```

---

## Task 2: `useEntitlements` hook + provider (TDD)

**Files:**
- Create: `apps/web/src/lib/entitlements-context.tsx`
- Create: `apps/web/test/entitlements-context.test.tsx`

EntitlementsContext 是单一数据源：
- 内部 state：`{ desired: string[]; observed: string[]; tokenVersion: number; loading: bool; error: Error | null }`
- 方法：`refetch()` 调 `api.status()` 重新填充
- 自动 polling：可选间隔（用于"启用云盘"等待时高频 poll；默认不 poll，靠 refetch）
- 暴露 `useEntitlements()` 给消费者

### Step 1: 写测试

Create `apps/web/test/entitlements-context.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { EntitlementsProvider, useEntitlements } from '../src/lib/entitlements-context.js';

vi.mock('../src/lib/api.js', () => ({
  status: vi.fn(),
  AuthError: class AuthError extends Error {},
}));

import * as api from '../src/lib/api.js';

function Probe() {
  const e = useEntitlements();
  return (
    <div>
      <span data-testid="loading">{String(e.loading)}</span>
      <span data-testid="desired">{e.desired.join(',')}</span>
      <span data-testid="observed">{e.observed.join(',')}</span>
      <button data-testid="refetch" onClick={() => void e.refetch()}>refetch</button>
    </div>
  );
}

describe('EntitlementsProvider + useEntitlements', () => {
  beforeEach(() => {
    vi.mocked(api.status).mockReset();
  });

  it('loads entitlements on mount', async () => {
    vi.mocked(api.status).mockResolvedValue({
      status: 'ready', provisioning_step: null, progress_pct: 100, error_message: null,
      entitlements_desired: ['cloud'], entitlements_observed: ['cloud'], container_token_version: 1,
    });
    render(<EntitlementsProvider><Probe /></EntitlementsProvider>);
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
    expect(screen.getByTestId('desired').textContent).toBe('cloud');
    expect(screen.getByTestId('observed').textContent).toBe('cloud');
  });

  it('handles null status (no container yet) gracefully', async () => {
    vi.mocked(api.status).mockResolvedValue(null as any);
    render(<EntitlementsProvider><Probe /></EntitlementsProvider>);
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
    expect(screen.getByTestId('desired').textContent).toBe('');
    expect(screen.getByTestId('observed').textContent).toBe('');
  });

  it('refetch() re-calls api.status', async () => {
    vi.mocked(api.status)
      .mockResolvedValueOnce({
        status: 'ready', provisioning_step: null, progress_pct: 100, error_message: null,
        entitlements_desired: [], entitlements_observed: [], container_token_version: 0,
      })
      .mockResolvedValueOnce({
        status: 'ready', provisioning_step: null, progress_pct: 100, error_message: null,
        entitlements_desired: ['cloud'], entitlements_observed: ['cloud'], container_token_version: 1,
      });
    render(<EntitlementsProvider><Probe /></EntitlementsProvider>);
    await waitFor(() => expect(screen.getByTestId('desired').textContent).toBe(''));
    await act(async () => { screen.getByTestId('refetch').click(); });
    await waitFor(() => expect(screen.getByTestId('desired').textContent).toBe('cloud'));
    expect(api.status).toHaveBeenCalledTimes(2);
  });
});
```

Run: `pnpm --filter @lingxi/web test -- entitlements-context`
Expected: module not found.

### Step 2: 实现

Create `apps/web/src/lib/entitlements-context.tsx`:

```typescript
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import * as api from './api.js';

export interface EntitlementsState {
  desired: string[];
  observed: string[];
  tokenVersion: number;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

const initial: EntitlementsState = {
  desired: [],
  observed: [],
  tokenVersion: 0,
  loading: true,
  error: null,
  refetch: async () => { /* default no-op replaced by provider */ },
};

const EntitlementsContext = createContext<EntitlementsState>(initial);

export const EntitlementsProvider = ({ children }: { children: ReactNode }) => {
  const [desired, setDesired] = useState<string[]>([]);
  const [observed, setObserved] = useState<string[]>([]);
  const [tokenVersion, setTokenVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const s = await api.status();
      if (s) {
        setDesired(s.entitlements_desired ?? []);
        setObserved(s.entitlements_observed ?? []);
        setTokenVersion(s.container_token_version ?? 0);
      } else {
        // 404 / no container — treat as empty entitlements (user hasn't provisioned yet)
        setDesired([]);
        setObserved([]);
        setTokenVersion(0);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refetch(); }, [refetch]);

  const value: EntitlementsState = { desired, observed, tokenVersion, loading, error, refetch };
  return <EntitlementsContext.Provider value={value}>{children}</EntitlementsContext.Provider>;
};

export const useEntitlements = (): EntitlementsState => useContext(EntitlementsContext);
```

### Step 3: Run + commit

```bash
pnpm --filter @lingxi/web test -- entitlements-context
pnpm --filter @lingxi/web run lint
pnpm --filter @lingxi/web test 2>&1 | tail -5
git add apps/web/src/lib/entitlements-context.tsx apps/web/test/entitlements-context.test.tsx
git commit -m "feat(web): EntitlementsContext + useEntitlements hook"
```

Expected: 3 new tests pass; preexisting 3 EventSource fails still fail (unchanged); 17 → 20 total。

---

## Task 3: Files App UI (TDD-light)

**Files:**
- Create: `apps/web/src/apps/files/types.ts`
- Create: `apps/web/src/apps/files/utils.ts`
- Create: `apps/web/src/apps/files/PathBar.tsx`
- Create: `apps/web/src/apps/files/Sidebar.tsx`
- Create: `apps/web/src/apps/files/FileList.tsx`
- Create: `apps/web/src/apps/files/FilesApp.tsx`
- Create: `apps/web/test/FilesApp.test.tsx`
- Create: `apps/web/test/FileList.test.tsx`
- Modify: `apps/web/src/lib/icons.tsx` (+ IconFolder, IconDownload, IconReload)

UI 风格：仿 macOS Finder 列表视图。复用现有 inline-style + CSS class (`btn`, `muted`, `card`)。
Sidebar 是占位（只有"我的云盘"链回根），不做"最近"/"Tags"等。

### Step 1: types + utils

Create `apps/web/src/apps/files/types.ts`:

```typescript
export interface FolderItem {
  virtual_path: string;          // relative to root, with trailing /
}

export interface FileItem {
  virtual_path: string;          // relative to root
  size: number;
  last_modified: string;
  content_type: string | null;
  title: string;                 // decoded UTF-8
  session_id: string | null;
}
```

Create `apps/web/src/apps/files/utils.ts`:

```typescript
export function fileIcon(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (['pdf'].includes(ext)) return '📄';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return '🖼️';
  if (['md', 'txt', 'csv'].includes(ext)) return '📝';
  if (['json', 'yaml', 'yml'].includes(ext)) return '📋';
  if (['zip', 'tar', 'gz', '7z'].includes(ext)) return '🗜️';
  if (['mp4', 'mov', 'avi', 'webm'].includes(ext)) return '🎬';
  if (['mp3', 'wav', 'flac', 'm4a'].includes(ext)) return '🎵';
  if (['js', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java'].includes(ext)) return '📃';
  return '📄';
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const today = d.toDateString() === now.toDateString();
  if (today) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  const sameYear = d.getFullYear() === now.getFullYear();
  if (sameYear) {
    return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  }
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' });
}

export function basename(virtualPath: string): string {
  const trimmed = virtualPath.replace(/\/+$/, '');
  return trimmed.split('/').pop() ?? trimmed;
}
```

### Step 2: 加 icons

Open `apps/web/src/lib/icons.tsx`. Find an existing icon (e.g., `IconGrid`) and add three new icons in the same lucide-style stroke pattern. The exact stroke paths are auxiliary — what matters is `IconFolder`, `IconDownload`, `IconReload` are exported with the same `{ size?: number; color?: string; strokeWidth?: number }` props signature as the other icons.

Add to `apps/web/src/lib/icons.tsx`:

```typescript
export const IconFolder = ({ size = 16, color = 'currentColor', strokeWidth = 1.8 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
);

export const IconDownload = ({ size = 16, color = 'currentColor', strokeWidth = 1.8 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

export const IconReload = ({ size = 16, color = 'currentColor', strokeWidth = 1.8 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10" />
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
  </svg>
);
```

Make sure `IconProps` type is exported or visible in the file. If existing icons use a different shape (e.g., inline `interface IconProps`), follow the same convention.

### Step 3: PathBar

Create `apps/web/src/apps/files/PathBar.tsx`:

```typescript
import { IconReload } from '../../lib/icons.js';

interface Props {
  currentPath: string;          // e.g. "reports/2026-06/"
  onNavigate: (path: string) => void;
  onRefresh: () => void;
}

export const PathBar = ({ currentPath, onNavigate, onRefresh }: Props) => {
  const segments = currentPath.split('/').filter(Boolean);
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
      <button
        className="link"
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
              className="link"
              onClick={() => onNavigate(sub)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px' }}
            >
              {seg}
            </button>
          </span>
        );
      })}
      <div style={{ flex: 1 }} />
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

### Step 4: Sidebar

Create `apps/web/src/apps/files/Sidebar.tsx`:

```typescript
import { IconFolder } from '../../lib/icons.js';

export const Sidebar = ({ onHome }: { onHome: () => void }) => (
  <div style={{ width: 160, borderRight: '1px solid var(--border)', padding: '12px 8px', background: 'var(--surface)' }}>
    <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', padding: '0 8px 6px' }}>位置</div>
    <button
      onClick={onHome}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
        width: '100%', border: 'none', background: 'none', cursor: 'pointer',
        borderRadius: 6, textAlign: 'left',
      }}
    >
      <IconFolder size={14} color="var(--accent)" />
      <span>我的云盘</span>
    </button>
  </div>
);
```

### Step 5: FileList

Create `apps/web/src/apps/files/FileList.tsx`:

```typescript
import type { FolderItem, FileItem } from './types.js';
import { fileIcon, formatSize, formatTime, basename } from './utils.js';

interface Props {
  folders: FolderItem[];
  files: FileItem[];
  onOpenFolder: (path: string) => void;
  onDownloadFile: (file: FileItem) => void;
  emptyMessage?: string;
}

export const FileList = ({ folders, files, onOpenFolder, onDownloadFile, emptyMessage }: Props) => {
  if (folders.length === 0 && files.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 13 }}>
        {emptyMessage ?? '还没有文件 · 让助理把成果发布到云盘'}
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
          {files.map((f) => (
            <tr
              key={f.virtual_path}
              data-testid={`file-row-${f.virtual_path}`}
              onDoubleClick={() => onDownloadFile(f)}
              style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)' }}
            >
              <td style={{ padding: '6px 12px' }}>{fileIcon(f.virtual_path)} {f.title}</td>
              <td style={{ padding: '6px 12px', color: 'var(--muted)' }}>{formatTime(f.last_modified)}</td>
              <td style={{ padding: '6px 12px', color: 'var(--muted)' }}>{formatSize(f.size)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
```

### Step 6: FilesApp

Create `apps/web/src/apps/files/FilesApp.tsx`:

```typescript
import { useEffect, useState, useCallback } from 'react';
import * as api from '../../lib/api.js';
import type { FolderItem, FileItem } from './types.js';
import { PathBar } from './PathBar.js';
import { Sidebar } from './Sidebar.js';
import { FileList } from './FileList.js';

export const FilesApp = () => {
  const [currentPath, setCurrentPath] = useState('');   // '' = root
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.cloudList(path);
      setFolders(data.folders);
      setFiles(data.files.map((f) => ({
        virtual_path: f.virtual_path,
        size: f.size,
        last_modified: f.last_modified,
        content_type: f.content_type,
        title: f.metadata.title,                  // gateway 已 decode UTF-8
        session_id: f.metadata.session_id,
      })));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setFolders([]);
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(currentPath); }, [currentPath, load]);

  const navigate = (path: string) => setCurrentPath(path);
  const refresh = () => { void load(currentPath); };
  const openFolder = (path: string) => setCurrentPath(path);
  const downloadFile = (file: FileItem) => {
    window.open(api.cloudDownloadUrl(file.virtual_path, 'attachment'), '_blank');
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%' }}>
      <PathBar currentPath={currentPath} onNavigate={navigate} onRefresh={refresh} />
      <div style={{ flex: 1, display: 'flex' }}>
        <Sidebar onHome={() => setCurrentPath('')} />
        {loading ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>
            加载中…
          </div>
        ) : error ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <div style={{ color: 'var(--err, #c00)' }}>加载失败：{error}</div>
            <button className="btn" onClick={refresh}>重试</button>
          </div>
        ) : (
          <FileList
            folders={folders}
            files={files}
            onOpenFolder={openFolder}
            onDownloadFile={downloadFile}
          />
        )}
      </div>
    </div>
  );
};
```

### Step 7: Tests

Create `apps/web/test/FilesApp.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { FilesApp } from '../src/apps/files/FilesApp.js';

vi.mock('../src/lib/api.js', () => ({
  cloudList: vi.fn(),
  cloudDownloadUrl: (path: string, dispose: string) => `/api/cloud/download?path=${path}&dispose=${dispose}`,
}));
import * as api from '../src/lib/api.js';

describe('FilesApp', () => {
  beforeEach(() => vi.mocked(api.cloudList).mockReset());

  it('loads the root list on mount and renders files', async () => {
    vi.mocked(api.cloudList).mockResolvedValue({
      folders: [{ virtual_path: 'reports/' }],
      files: [{
        virtual_path: 'hello.pdf',
        size: 1024,
        last_modified: new Date().toISOString(),
        content_type: 'application/pdf',
        metadata: { title: 'Hello', session_id: 'main', published_at: null, tool_version: null, description: null, tags: null },
      }],
    });
    render(<FilesApp />);
    await waitFor(() => expect(screen.queryByText('加载中…')).not.toBeInTheDocument());
    expect(screen.getByText(/reports/)).toBeInTheDocument();
    expect(screen.getByText(/Hello/)).toBeInTheDocument();
  });

  it('shows error and retry button when load fails', async () => {
    vi.mocked(api.cloudList).mockRejectedValue(new Error('boom'));
    render(<FilesApp />);
    await waitFor(() => expect(screen.getByText(/加载失败/)).toBeInTheDocument());
    expect(screen.getByText('重试')).toBeInTheDocument();
  });

  it('shows empty state when no folders/files', async () => {
    vi.mocked(api.cloudList).mockResolvedValue({ folders: [], files: [] });
    render(<FilesApp />);
    await waitFor(() => expect(screen.getByText(/还没有文件/)).toBeInTheDocument());
  });
});
```

Create `apps/web/test/FileList.test.tsx`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FileList } from '../src/apps/files/FileList.js';

describe('FileList', () => {
  it('double-click folder triggers onOpenFolder', () => {
    const onOpenFolder = vi.fn();
    render(
      <FileList
        folders={[{ virtual_path: 'reports/' }]}
        files={[]}
        onOpenFolder={onOpenFolder}
        onDownloadFile={vi.fn()}
      />
    );
    fireEvent.doubleClick(screen.getByTestId('folder-row-reports/'));
    expect(onOpenFolder).toHaveBeenCalledWith('reports/');
  });

  it('double-click file triggers onDownloadFile with the file object', () => {
    const onDownloadFile = vi.fn();
    const file = {
      virtual_path: 'hello.pdf', size: 100, last_modified: new Date().toISOString(),
      content_type: 'application/pdf', title: 'Hello', session_id: null,
    };
    render(
      <FileList
        folders={[]}
        files={[file]}
        onOpenFolder={vi.fn()}
        onDownloadFile={onDownloadFile}
      />
    );
    fireEvent.doubleClick(screen.getByTestId('file-row-hello.pdf'));
    expect(onDownloadFile).toHaveBeenCalledWith(file);
  });

  it('shows empty message when both lists empty', () => {
    render(
      <FileList
        folders={[]}
        files={[]}
        onOpenFolder={vi.fn()}
        onDownloadFile={vi.fn()}
      />
    );
    expect(screen.getByText(/还没有文件/)).toBeInTheDocument();
  });
});
```

### Step 8: Run + commit

```bash
pnpm --filter @lingxi/web test -- "(FilesApp|FileList)"
pnpm --filter @lingxi/web run lint
pnpm --filter @lingxi/web test 2>&1 | tail -5
git add apps/web/src/apps/files/ apps/web/src/lib/icons.tsx \
        apps/web/test/FilesApp.test.tsx apps/web/test/FileList.test.tsx
git commit -m "feat(web): Files App MVP (list + double-click navigate/download)"
```

Expected: 6 new tests pass (FilesApp 3 + FileList 3); total ~26 (was 20 after Task 2, +6); 3 EventSource still fails (preexisting unchanged); lint clean.

---

## Task 4: Desktop / Dock entitlements awareness

**Files:**
- Modify: `apps/web/src/desktop/Dock.tsx`
- Modify: `apps/web/src/desktop/Desktop.tsx`
- Modify: `apps/web/src/App.tsx`
- Create: `apps/web/test/Dock.test.tsx`

Make Dock take an `entitlements` prop; conditionally render Files icon. Register `files` in Desktop's app registry. Wire EntitlementsProvider in App root.

### Step 1: Wrap App with provider

Edit `apps/web/src/App.tsx` — change so `Desktop` is wrapped in `EntitlementsProvider` (only inside `ProtectedRoute`, so guests don't fire api.status):

Find the existing `<Route path="/desktop" element={<ProtectedRoute><Desktop /></ProtectedRoute>} />` and change to:

```typescript
import { EntitlementsProvider } from './lib/entitlements-context.js';

// ...

<Route
  path="/desktop"
  element={
    <ProtectedRoute>
      <EntitlementsProvider>
        <Desktop />
      </EntitlementsProvider>
    </ProtectedRoute>
  }
/>
```

### Step 2: Dock takes entitlements

Edit `apps/web/src/desktop/Dock.tsx` — extend `DockAppId` and add conditional rendering.

```typescript
import type { ReactNode } from 'react';
import { IconSpark, IconGrid, IconFolder } from '../lib/icons.js';

export type DockAppId = 'chat' | 'manage' | 'files';

interface AppDef { id: DockAppId; name: string; icon: ReactNode; c1: string; c2: string }

const baseApps: AppDef[] = [
  { id: 'chat',   name: '灵犀助理', icon: <IconSpark size={24} />, c1: '#8b5cf6', c2: '#6d28d9' },
  { id: 'manage', name: '我的助理', icon: <IconGrid size={24} />,  c1: '#3b82f6', c2: '#1d4ed8' },
];

const conditionalApps: Record<string, AppDef> = {
  cloud: { id: 'files', name: '文件', icon: <IconFolder size={24} />, c1: '#22c55e', c2: '#15803d' },
};

interface DockProps {
  onOpen: (id: DockAppId) => void;
  openApps: ReadonlySet<string>;
  entitlements: string[];
}

export const Dock = ({ onOpen, openApps, entitlements }: DockProps) => {
  const apps: AppDef[] = [
    ...baseApps,
    ...entitlements
      .filter((feature) => conditionalApps[feature])
      .map((feature) => conditionalApps[feature]!),
  ];

  return (
    <div style={{
      position: 'absolute', bottom: 9, left: '50%', transform: 'translateX(-50%)',
      display: 'flex', alignItems: 'flex-end', gap: 11, padding: '8px 11px',
      borderRadius: 22, zIndex: 1000,
      background: 'rgba(255,255,255,0.32)',
      backdropFilter: 'blur(26px) saturate(180%)',
      border: '1px solid rgba(255,255,255,0.5)',
      boxShadow: '0 14px 44px rgba(0,0,0,0.3)',
    }}>
      {apps.map((a) => (
        <button key={a.id} title={a.name} onClick={() => onOpen(a.id)} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div style={{
            width: 52, height: 52, borderRadius: 14, display: 'flex',
            alignItems: 'center', justifyContent: 'center', color: '#fff',
            background: `linear-gradient(160deg, ${a.c1}, ${a.c2})`,
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.5), 0 7px 16px rgba(0,0,0,0.22)',
            transition: 'transform 0.18s cubic-bezier(0.25,1.4,0.5,1)',
          }}>{a.icon}</div>
          <span style={{ width: 4, height: 4, borderRadius: '50%', background: 'rgba(0,0,0,0.5)', marginTop: 4, opacity: openApps.has(a.id) ? 1 : 0 }} />
        </button>
      ))}
    </div>
  );
};
```

### Step 3: Desktop registers files app + passes entitlements to Dock

Edit `apps/web/src/desktop/Desktop.tsx`:

- Import `useEntitlements`:
  ```typescript
  import { useEntitlements } from '../lib/entitlements-context.js';
  import { FilesApp } from '../apps/files/FilesApp.js';
  import { IconFolder } from '../lib/icons.js';
  ```
- Extend `AppId`:
  ```typescript
  type AppId = DockAppId | 'wechat';   // DockAppId now includes 'files'
  ```
- Add to `titles`:
  ```typescript
  files: { title: '文件', icon: <IconFolder size={14} />, w: 900, h: 600 },
  ```
- Extend `renderApp`:
  ```typescript
  if (id === 'files') return <FilesApp />;
  ```
- In the component, call `const { observed } = useEntitlements();` and pass to Dock:
  ```typescript
  <Dock onOpen={openApp} openApps={new Set(openApps)} entitlements={observed} />
  ```

### Step 4: Dock test

Create `apps/web/test/Dock.test.tsx`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Dock } from '../src/desktop/Dock.js';

describe('Dock', () => {
  it('always shows base apps (chat + manage)', () => {
    render(<Dock onOpen={vi.fn()} openApps={new Set()} entitlements={[]} />);
    expect(screen.getByTitle('灵犀助理')).toBeInTheDocument();
    expect(screen.getByTitle('我的助理')).toBeInTheDocument();
  });

  it('hides Files when entitlements does not include cloud', () => {
    render(<Dock onOpen={vi.fn()} openApps={new Set()} entitlements={[]} />);
    expect(screen.queryByTitle('文件')).not.toBeInTheDocument();
  });

  it('shows Files when entitlements includes cloud', () => {
    render(<Dock onOpen={vi.fn()} openApps={new Set()} entitlements={['cloud']} />);
    expect(screen.getByTitle('文件')).toBeInTheDocument();
  });

  it('clicking Files calls onOpen with files id', () => {
    const onOpen = vi.fn();
    render(<Dock onOpen={onOpen} openApps={new Set()} entitlements={['cloud']} />);
    screen.getByTitle('文件').click();
    expect(onOpen).toHaveBeenCalledWith('files');
  });
});
```

### Step 5: Run + commit

```bash
pnpm --filter @lingxi/web test -- Dock
pnpm --filter @lingxi/web test 2>&1 | tail -5
pnpm --filter @lingxi/web run lint
git add apps/web/src/desktop/Dock.tsx \
        apps/web/src/desktop/Desktop.tsx \
        apps/web/src/App.tsx \
        apps/web/test/Dock.test.tsx
git commit -m "feat(web): Dock + Desktop entitlements-aware (Files app conditional)"
```

Expected: 4 new Dock tests pass; full suite +4 (~30 total); lint clean.

---

## Task 5: ManageApp "Enable Cloud" button + waiting Modal (TDD)

**Files:**
- Create: `apps/web/src/apps/manage/EnableCloudButton.tsx`
- Create: `apps/web/test/EnableCloudButton.test.tsx`
- Modify: `apps/web/src/apps/manage/ManageApp.tsx`

`EnableCloudButton` 状态机：
- `idle` → 显示"启用云盘"按钮
- 点 → `posting`：调 `api.enableCloud()`
- → `polling`：每 2s 调 `useEntitlements().refetch()`，等到 `observed.includes('cloud')`，最长 30s
- → `ready` → 关 Modal + 调 `onReady` callback
- 任意阶段 fail → `error` → "重试"按钮

如果用户已经开通（initial `observed.includes('cloud')`），按钮显示"✓ 已启用"。

### Step 1: Test

Create `apps/web/test/EnableCloudButton.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { EnableCloudButton } from '../src/apps/manage/EnableCloudButton.js';
import { EntitlementsProvider } from '../src/lib/entitlements-context.js';

vi.mock('../src/lib/api.js', () => ({
  enableCloud: vi.fn(),
  status: vi.fn(),
  AuthError: class extends Error {},
}));
import * as api from '../src/lib/api.js';

function setObserved(observed: string[]) {
  vi.mocked(api.status).mockResolvedValue({
    status: 'ready', provisioning_step: null, progress_pct: 100, error_message: null,
    entitlements_desired: observed, entitlements_observed: observed, container_token_version: 1,
  });
}

describe('EnableCloudButton', () => {
  beforeEach(() => { vi.useFakeTimers(); setObserved([]); vi.mocked(api.enableCloud).mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it('shows "启用云盘" when cloud not active', async () => {
    render(
      <EntitlementsProvider>
        <EnableCloudButton onReady={vi.fn()} />
      </EntitlementsProvider>
    );
    await waitFor(() => expect(screen.getByText(/启用云盘/)).toBeInTheDocument());
  });

  it('shows "已启用" when cloud is in observed', async () => {
    setObserved(['cloud']);
    render(
      <EntitlementsProvider>
        <EnableCloudButton onReady={vi.fn()} />
      </EntitlementsProvider>
    );
    await waitFor(() => expect(screen.getByText(/已启用/)).toBeInTheDocument());
  });

  it('clicking the button opens Modal in "posting" state then polls', async () => {
    vi.mocked(api.enableCloud).mockResolvedValue({ ok: true, entitlements: ['cloud'], changed: true });
    // first refetch returns no observed yet; later one will have observed:['cloud']
    vi.mocked(api.status)
      .mockResolvedValueOnce({
        status: 'ready', provisioning_step: null, progress_pct: 100, error_message: null,
        entitlements_desired: [], entitlements_observed: [], container_token_version: 0,
      })
      .mockResolvedValueOnce({
        status: 'ready', provisioning_step: null, progress_pct: 100, error_message: null,
        entitlements_desired: ['cloud'], entitlements_observed: [], container_token_version: 1,
      })
      .mockResolvedValue({
        status: 'ready', provisioning_step: null, progress_pct: 100, error_message: null,
        entitlements_desired: ['cloud'], entitlements_observed: ['cloud'], container_token_version: 1,
      });
    const onReady = vi.fn();
    render(
      <EntitlementsProvider>
        <EnableCloudButton onReady={onReady} />
      </EntitlementsProvider>
    );
    await waitFor(() => expect(screen.getByText(/启用云盘/)).toBeInTheDocument());

    fireEvent.click(screen.getByText(/启用云盘/));
    await waitFor(() => expect(screen.getByText(/正在启用|启用中|助理重启中/)).toBeInTheDocument());

    // advance timers to trigger poll
    for (let i = 0; i < 5; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    }

    await waitFor(() => expect(onReady).toHaveBeenCalled());
  });
});
```

### Step 2: Implementation

Create `apps/web/src/apps/manage/EnableCloudButton.tsx`:

```typescript
import { useState, useRef, useEffect } from 'react';
import * as api from '../../lib/api.js';
import { useEntitlements } from '../../lib/entitlements-context.js';

type Phase = 'idle' | 'posting' | 'polling' | 'ready' | 'failed' | 'timeout';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 30_000;

export const EnableCloudButton = ({ onReady }: { onReady: () => void }) => {
  const ent = useEntitlements();
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const intervalRef = useRef<number | null>(null);

  const isActive = ent.observed.includes('cloud');

  useEffect(() => {
    // If we're polling and observed flips to include cloud → success
    if (phase === 'polling' && isActive) {
      cleanup();
      setPhase('ready');
      onReady();
    }
  }, [phase, isActive, onReady]);

  function cleanup() {
    if (timeoutRef.current) { window.clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    if (intervalRef.current) { window.clearInterval(intervalRef.current); intervalRef.current = null; }
  }
  useEffect(() => cleanup, []);

  async function handleEnable(): Promise<void> {
    setPhase('posting');
    setErrorMsg(null);
    try {
      await api.enableCloud();
      setPhase('polling');
      intervalRef.current = window.setInterval(() => { void ent.refetch(); }, POLL_INTERVAL_MS);
      timeoutRef.current = window.setTimeout(() => {
        cleanup();
        setPhase('timeout');
      }, POLL_TIMEOUT_MS);
      void ent.refetch();  // immediate first poll
    } catch (err) {
      setPhase('failed');
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }

  if (isActive && phase !== 'polling' && phase !== 'posting') {
    return (
      <button className="btn" disabled style={{ background: '#16a34a', color: 'white' }}>
        ☁️ 已启用云盘
      </button>
    );
  }

  return (
    <>
      <button
        className="btn btn-primary"
        onClick={() => void handleEnable()}
        disabled={phase !== 'idle' && phase !== 'failed' && phase !== 'timeout'}
        style={{ background: '#0ea5e9' }}
      >
        ☁️ 启用云盘
      </button>

      {(phase === 'posting' || phase === 'polling' || phase === 'failed' || phase === 'timeout') && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000,
        }}>
          <div className="card" style={{ width: 360, padding: 28, textAlign: 'center' }}>
            <div style={{ fontSize: 36, marginBottom: 8 }}>☁️</div>
            {phase === 'posting' && <div style={{ fontWeight: 600 }}>正在记录权益…</div>}
            {phase === 'polling' && (
              <>
                <div style={{ fontWeight: 600 }}>助理重启中…</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>预计 5 - 15 秒</div>
              </>
            )}
            {phase === 'failed' && (
              <>
                <div style={{ fontWeight: 600, color: 'var(--err, #c00)' }}>启用失败</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{errorMsg}</div>
                <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'center' }}>
                  <button className="btn" onClick={() => setPhase('idle')}>关闭</button>
                  <button className="btn btn-primary" onClick={() => void handleEnable()}>重试</button>
                </div>
              </>
            )}
            {phase === 'timeout' && (
              <>
                <div style={{ fontWeight: 600 }}>启用未完成</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                  请稍后在"我的助理"重试
                </div>
                <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'center' }}>
                  <button className="btn" onClick={() => setPhase('idle')}>关闭</button>
                  <button className="btn btn-primary" onClick={() => void handleEnable()}>立即重试</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
};
```

### Step 3: Mount in ManageApp

Edit `apps/web/src/apps/manage/ManageApp.tsx`. Add a new "功能 / 订阅" section after the existing 已装备能力 grid. Use a simple horizontal row with the EnableCloudButton.

In `ManageApp.tsx`, add:

```typescript
import { EnableCloudButton } from './EnableCloudButton.js';
```

Inside the existing JSX, after the closing `</div>` of the `caps.map(...)` grid, before the outer wrappers close, insert:

```typescript
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '24px 0 12px' }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>功能 / 订阅</div>
        </div>
        <div className="card" style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 14 }}>
          <span style={{ fontSize: 26 }}>☁️</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>云盘</div>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
              启用后助理可发布文件，桌面将出现"文件"应用
            </div>
          </div>
          <EnableCloudButton onReady={() => { /* Desktop will react via context; no-op here */ }} />
        </div>
```

Note: The `onReady` callback could also trigger Desktop to auto-open Files App. That's done in Task 6 (`Desktop.tsx` observes entitlements change and auto-opens).

### Step 4: Run + commit

```bash
pnpm --filter @lingxi/web test -- "(EnableCloudButton|ManageApp)"
pnpm --filter @lingxi/web test 2>&1 | tail -5
pnpm --filter @lingxi/web run lint
git add apps/web/src/apps/manage/EnableCloudButton.tsx \
        apps/web/src/apps/manage/ManageApp.tsx \
        apps/web/test/EnableCloudButton.test.tsx
git commit -m "feat(web): ManageApp Enable Cloud button + waiting modal"
```

Expected: 3 new tests pass; total ~33; lint clean.

---

## Task 6: Auto-open Files App after Enable + 端到端手测

**Files:**
- Modify: `apps/web/src/desktop/Desktop.tsx`

When entitlements observed flips from "no cloud" to "has cloud", auto-open Files App. This gives the user immediate visual feedback that the Enable flow succeeded.

### Step 1: Auto-open Files on entitlements change

In `apps/web/src/desktop/Desktop.tsx`, add a `useEffect` that watches `observed` for cloud appearance:

```typescript
const { observed } = useEntitlements();
const cloudObservedRef = useRef(observed.includes('cloud'));

useEffect(() => {
  const had = cloudObservedRef.current;
  const has = observed.includes('cloud');
  if (!had && has) {
    // cloud just became active → auto-open Files
    openApp('files');
  }
  cloudObservedRef.current = has;
}, [observed]);
```

Make sure `useRef` is imported from React.

### Step 2: Lint + commit

```bash
pnpm --filter @lingxi/web run lint
git add apps/web/src/desktop/Desktop.tsx
git commit -m "feat(web): auto-open Files App when cloud entitlement becomes active"
```

### Step 3: 端到端手测 instructions

This is documentation, not code. Add `docs/superpowers/manuals/2026-06-02-cloud-drive-p4-p5-manual-e2e.md`:

```markdown
# Cloud Drive P4+P5 — Manual End-to-End Verification

## Prereqs
- `supabase start --workdir infra` running
- `.env.local` has SUPABASE_*, GOOGLE_*, AZURE_STORAGE_* set
- `pnpm dev` running (hermes + gateway + web)
- Browser logged in to the web app via Google OAuth

## Happy path (with mock observed)

1. Open http://localhost:3000/desktop
2. Open "我的助理" (Manage app)
3. Click "☁️ 启用云盘" button
4. Modal opens — first shows "正在记录权益…", then "助理重启中…"
5. Behind the scenes, gateway has:
   - INSERT into user_entitlements (user_id, feature='cloud')
   - bumped users.token_version
   - called provisioning local mock (logs to gateway stdout, but no real restart)
   - The container will never actually report observed because local provisioner is a mock
6. **To simulate the container reporting observed back**, run in a separate terminal:
   ```bash
   USER_ID=<your user uuid, get from psql>
   PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c \
     "INSERT INTO container_observed_state (user_id, observed_entitlements, observed_token_version) \
      VALUES ('$USER_ID', ARRAY['cloud'], 1) \
      ON CONFLICT (user_id) DO UPDATE SET observed_entitlements = ARRAY['cloud'], observed_token_version = 1, reported_at = NOW();"
   ```
7. Within 2s the web Modal will detect observed → close → Dock shows ☁️ Files icon → Files App auto-opens
8. Files App initially shows "还没有文件 · 让助理把成果发布到云盘" (since no blobs uploaded yet — that's P3)

## How to find your user_id

```bash
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c \
  "SELECT id, email FROM users;"
```

## Disable flow

Currently `EnableCloudButton` only handles enable. Disable can be triggered via:
```bash
curl -X POST http://localhost:9000/api/entitlements/cloud/disable \
  -H "Cookie: lingxi_sid=<from browser>" 
```
Or wait for P6 / future where disable button is added to settings.
```

### Step 4: Commit

```bash
git add docs/superpowers/manuals/2026-06-02-cloud-drive-p4-p5-manual-e2e.md
git commit -m "docs(cloud-drive): P4+P5 manual e2e verification steps"
```

### Step 5: Full validation

```bash
SUPABASE_SERVICE_ROLE_KEY=$(grep ^SUPABASE_SERVICE_ROLE_KEY apps/gateway/.env.local | cut -d= -f2-) \
  pnpm test 2>&1 | tail -20
pnpm lint 2>&1 | tail -10
git log --oneline main..HEAD | head -10
```

Expected:
- gateway: 232 (218 + 14 skipped) — unchanged
- shared: 18 — unchanged
- web: ~34 (was 17 baseline, +17 new — 3 EventSource still fail = ~31 pass)
- all lints clean

---

## 验收清单 (P4+P5 整体)

- [ ] `cloudList` / `enableCloud` / `disableCloud` / `cloudDownloadUrl` in `apps/web/src/lib/api.ts`
- [ ] `EntitlementsContext` + `useEntitlements` hook + 3 tests
- [ ] Files App `FilesApp/FileList/PathBar/Sidebar/types/utils` + 6 tests
- [ ] `Dock` accepts `entitlements` + conditional Files icon + 4 tests
- [ ] `Desktop` registers `files` app + auto-opens on entitlement flip
- [ ] `EnableCloudButton` Modal state machine + 3 tests
- [ ] `ManageApp` shows "功能 / 订阅" section with EnableCloudButton
- [ ] Manual e2e doc explaining how to simulate observed report
- [ ] All lints clean
- [ ] Web tests +17 (~34 total), no regression
- [ ] 6 task commits + 1 docs commit on `feat/cloud-drive`

---

## 风险与未决项

| 项 | 风险 | 缓解 |
|---|---|---|
| EventSource preexisting fails | Conversation.tsx 在 jsdom 跑会 ReferenceError | 本 plan 不动它；新加测试要避免引入相同问题（don't import Conversation in new test files） |
| FilesApp 的 download 调 `window.open` | jsdom 实现的 `window.open` 返回 null，但不抛错；测试 mock 验证调用即可 | 测试只检查 `cloudDownloadUrl` 被正确构造 |
| ManageApp 改动可能影响现有微信绑定 UI | 已有用户接受当前布局 | 只新增 section，不动现有 caps grid 和绑定按钮 |
| EnableCloud Modal 用 timeout 检测；jsdom timer 行为有时奇怪 | `vi.useFakeTimers` + `vi.advanceTimersByTimeAsync` 配合可控 | 测试覆盖核心状态转换；视觉细节走端到端手测 |
| 端到端手测需要 psql INSERT | local 容器永远不会真上报 | 这是已知 local-dev 限制（P1 plan 已说明）；真实 Azure 部署时 entrypoint 会自然上报 |
| `useEntitlements` 在 ProtectedRoute 外触发 | App.tsx 改动后只在 ProtectedRoute 内 wrap；guest 路由不触发 api.status | 已正确放置 |

### Open Questions

- 是否需要做"主动 disable cloud"按钮？P4+P5 范围内只做 enable；disable 走 curl 即可。**Defer** 到 P6/P7 settings 完善期。
- Files App 是否要做 keyboard shortcut（Enter / Backspace 上下导航）？**Defer** 到 P6。
- ManageApp 改动是否破坏现有截图测试？apps/web 没有截图测试，只有 RTL，不会断。

---

## 相关文档

- 设计 spec：`docs/superpowers/specs/2026-06-01-cloud-drive-design.md`
- P0 plan：`docs/superpowers/plans/2026-06-01-cloud-drive-p0.md`
- P1 plan：`docs/superpowers/plans/2026-06-02-cloud-drive-p1.md`
- P2 plan：`docs/superpowers/plans/2026-06-02-cloud-drive-p2.md`
