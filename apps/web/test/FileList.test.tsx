import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FileList } from '../src/apps/files/FileList.js';

describe('FileList', () => {
  it('double-click folder triggers onOpenFolder', () => {
    const onOpenFolder = vi.fn();
    render(
      <FileList
        folders={[{ virtual_path: 'reports/' }]}
        files={[]}
        onOpenFolder={onOpenFolder}
        onDownloadFile={vi.fn()}
      />
    );
    fireEvent.doubleClick(screen.getByTestId('folder-row-reports/'));
    expect(onOpenFolder).toHaveBeenCalledWith('reports/');
  });

  it('double-click file triggers onDownloadFile with the file object', () => {
    const onDownloadFile = vi.fn();
    const file = {
      virtual_path: 'hello.pdf', size: 100, last_modified: new Date().toISOString(),
      content_type: 'application/pdf', title: 'Hello', session_id: null,
    };
    render(
      <FileList
        folders={[]}
        files={[file]}
        onOpenFolder={vi.fn()}
        onDownloadFile={onDownloadFile}
      />
    );
    fireEvent.doubleClick(screen.getByTestId('file-row-hello.pdf'));
    expect(onDownloadFile).toHaveBeenCalledWith(file);
  });

  it('shows empty message when both lists empty', () => {
    render(
      <FileList
        folders={[]}
        files={[]}
        onOpenFolder={vi.fn()}
        onDownloadFile={vi.fn()}
      />
    );
    expect(screen.getByText(/还没有文件/)).toBeInTheDocument();
  });
});
