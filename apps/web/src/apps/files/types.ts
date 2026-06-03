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
