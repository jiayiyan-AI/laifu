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
  onShowSyncFlyout?: () => void;
}

export const PathBar = ({ currentPath, selectedCount, canPreview, onNavigate, onRefresh, onUploadClick, onPreview, onDownload, onShowSyncFlyout }: Props) => {
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
      {onShowSyncFlyout && (
        <button className="btn" onClick={onShowSyncFlyout} style={{ marginRight: 8 }}>
          同步状态
        </button>
      )}
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
