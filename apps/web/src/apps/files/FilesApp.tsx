import { useEffect, useState, useCallback, useRef, useMemo, type ChangeEvent, type DragEvent } from 'react';
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

  const existingPaths = useMemo(() => new Set(files.map((f) => f.virtual_path)), [files]);
  const fileByPath = useMemo(() => new Map(files.map((f) => [f.virtual_path, f])), [files]);

  const onSelectFile = (path: string, mods: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (mods.metaKey || mods.ctrlKey) {
        if (next.has(path)) next.delete(path); else next.add(path);
        return next;
      }
      if (mods.shiftKey && prev.size > 0) {
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
    else setSelected(new Set([file.virtual_path]));
  };

  const selectedFiles = useMemo(
    () => [...selected].map((p) => fileByPath.get(p)).filter(Boolean) as FileItem[],
    [selected, fileByPath],
  );
  const canPreview = selected.size === 1 && selectedFiles.length === 1 && isPreviewable(selectedFiles[0]!);

  const onPreview = () => { const f = selectedFiles[0]; if (f) setPreview(f); };
  const onDownload = () => {
    for (const f of selectedFiles) {
      window.open(api.cloudDownloadUrl(f.virtual_path, 'attachment'), '_blank');
    }
  };

  const onUploadClick = () => fileInputRef.current?.click();
  const onFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files ? Array.from(e.target.files) : [];
    if (list.length) uploaderRef.current?.uploadFiles(list);
    e.target.value = '';
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
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
