import { forwardRef, useImperativeHandle, useState } from 'react';
import * as api from '../../lib/api.js';

export interface UploadHandle {
  uploadFiles: (files: File[]) => void;
}

interface Props {
  currentPath: string;             // 形如 '' 或 'inbox/'
  existingPaths: Set<string>;      // 当前云盘已有文件的 virtual_path 全集
  onUploaded: () => void;          // 所有上传尝试结束后触发（无论成功失败，用于刷新列表）
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
      if (!f) break;
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
            <div style={{ fontWeight: 600, marginBottom: 8 }}>
              <span>{pendingConflicts.length} 个文件冲突</span>
            </div>
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

UploadController.displayName = 'UploadController';
