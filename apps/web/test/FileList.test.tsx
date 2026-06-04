import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FileList } from '../src/apps/files/FileList.js';
import type { FileItem } from '../src/apps/files/types.js';

const mkFile = (over: Partial<FileItem> = {}): FileItem => ({
  virtual_path: 'hello.pdf', size: 100, last_modified: new Date().toISOString(),
  content_type: 'application/pdf', title: 'Hello', session_id: null, source: 'agent', ...over,
});

function renderList(props: Partial<React.ComponentProps<typeof FileList>> = {}) {
  return render(
    <FileList
      folders={props.folders ?? []}
      files={props.files ?? []}
      selected={props.selected ?? new Set()}
      onOpenFolder={props.onOpenFolder ?? vi.fn()}
      onSelectFile={props.onSelectFile ?? vi.fn()}
      onActivateFile={props.onActivateFile ?? vi.fn()}
    />
  );
}

describe('FileList', () => {
  it('double-click folder triggers onOpenFolder', () => {
    const onOpenFolder = vi.fn();
    renderList({ folders: [{ virtual_path: 'reports/' }], onOpenFolder });
    fireEvent.doubleClick(screen.getByTestId('folder-row-reports/'));
    expect(onOpenFolder).toHaveBeenCalledWith('reports/');
  });

  it('single-click file triggers onSelectFile with path + modifiers', () => {
    const onSelectFile = vi.fn();
    renderList({ files: [mkFile()], onSelectFile });
    fireEvent.click(screen.getByTestId('file-row-hello.pdf'));
    expect(onSelectFile).toHaveBeenCalled();
    expect(onSelectFile.mock.calls[0]?.[0]).toBe('hello.pdf');
  });

  it('double-click file triggers onActivateFile', () => {
    const onActivateFile = vi.fn();
    const f = mkFile();
    renderList({ files: [f], onActivateFile });
    fireEvent.doubleClick(screen.getByTestId('file-row-hello.pdf'));
    expect(onActivateFile).toHaveBeenCalledWith(f);
  });

  it('selected row gets aria-selected', () => {
    renderList({ files: [mkFile()], selected: new Set(['hello.pdf']) });
    expect(screen.getByTestId('file-row-hello.pdf')).toHaveAttribute('aria-selected', 'true');
  });

  it('web-source file shows ↥ badge; agent file does not', () => {
    renderList({ files: [mkFile({ virtual_path: 'up.csv', title: 'Up', source: 'web', content_type: 'text/csv' })] });
    expect(screen.getByTestId('file-row-up.csv').textContent).toContain('↥');
  });

  it('shows empty message when both lists empty', () => {
    renderList({});
    expect(screen.getByText(/还没有文件/)).toBeInTheDocument();
  });
});
