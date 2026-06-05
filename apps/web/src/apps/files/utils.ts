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
