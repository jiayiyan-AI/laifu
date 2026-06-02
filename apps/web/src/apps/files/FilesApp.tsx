import { useEffect, useState, useCallback } from 'react';
import * as api from '../../lib/api.js';
import type { FolderItem, FileItem } from './types.js';
import { PathBar } from './PathBar.js';
import { Sidebar } from './Sidebar.js';
import { FileList } from './FileList.js';

export const FilesApp = () => {
  const [currentPath, setCurrentPath] = useState('');
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
        title: f.metadata.title,
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

  useEffect(() => { load(currentPath).catch(() => {}); }, [currentPath, load]);

  const navigate = (path: string) => setCurrentPath(path);
  const refresh = () => { load(currentPath).catch(() => {}); };
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
