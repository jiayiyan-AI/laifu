import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { FilesApp } from '../src/apps/files/FilesApp.js';

vi.mock('../src/lib/api.js', () => ({
  cloudList: vi.fn(),
  cloudDownloadUrl: (path: string, dispose: string) => `/api/cloud/download?path=${path}&dispose=${dispose}`,
}));
import * as api from '../src/lib/api.js';

describe('FilesApp', () => {
  beforeEach(() => {
    vi.mocked(api.cloudList).mockReset();
  });

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
    let rejectionFired = false;
    const trackRejection = (err: unknown) => {
      rejectionFired = true;
      console.log('UNHANDLED REJECTION:', (err as Error)?.message);
    };
    process.prependListener('unhandledRejection', trackRejection);

    vi.mocked(api.cloudList).mockRejectedValue(new Error('boom'));
    render(<FilesApp />);

    await waitFor(() => expect(screen.getByText(/加载失败/)).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByText('重试')).toBeInTheDocument();

    process.off('unhandledRejection', trackRejection);
    void rejectionFired;
  });

  it('shows empty state when no folders/files', async () => {
    vi.mocked(api.cloudList).mockResolvedValue({ folders: [], files: [] });
    render(<FilesApp />);
    await waitFor(() => expect(screen.getByText(/还没有文件/)).toBeInTheDocument());
  });
});
