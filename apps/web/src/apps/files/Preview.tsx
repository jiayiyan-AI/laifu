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
