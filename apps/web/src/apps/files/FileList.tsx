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
