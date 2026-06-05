import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { FilesApp } from '../src/apps/files/FilesApp.js';

vi.mock('../src/lib/api.js', () => ({
  cloudList: vi.fn(),
  cloudUpload: vi.fn(),
  cloudDownloadUrl: (path: string, dispose: string) => `/api/cloud/download?path=${path}&dispose=${dispose}`,
}));
import * as api from '../src/lib/api.js';

const fileMeta = (over = {}) => ({ title: 'Hello', session_id: 'main', published_at: null, tool_version: null, description: null, tags: null, source: 'agent' as const, ...over });

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
    expect(screen.getByText('预览')).toBeInTheDocument();
  });

  it('double-click pdf opens preview modal', async () => {
    vi.mocked(api.cloudList).mockResolvedValue({
      folders: [],
      files: [{ virtual_path: 'hello.pdf', size: 1024, last_modified: new Date().toISOString(), content_type: 'application/pdf', metadata: fileMeta() }],
    });
    render(<FilesApp />);
    await waitFor(() => expect(screen.getByTestId('file-row-hello.pdf')).toBeInTheDocument());
    fireEvent.doubleClick(screen.getByTestId('file-row-hello.pdf'));
    expect(screen.getByTitle('Hello')).toBeInTheDocument();
  });

  it('shows error and retry button when load fails', async () => {
    vi.mocked(api.cloudList).mockRejectedValue(new Error('boom'));
    render(<FilesApp />);
    await waitFor(() => expect(screen.getByText(/加载失败/)).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByText('重试')).toBeInTheDocument();
  });
});
