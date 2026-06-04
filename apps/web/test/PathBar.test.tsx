import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PathBar } from '../src/apps/files/PathBar.js';

function renderBar(props: Partial<React.ComponentProps<typeof PathBar>> = {}) {
  return render(
    <PathBar
      currentPath={props.currentPath ?? ''}
      selectedCount={props.selectedCount ?? 0}
      canPreview={props.canPreview ?? false}
      onNavigate={props.onNavigate ?? vi.fn()}
      onRefresh={props.onRefresh ?? vi.fn()}
      onUploadClick={props.onUploadClick ?? vi.fn()}
      onPreview={props.onPreview ?? vi.fn()}
      onDownload={props.onDownload ?? vi.fn()}
    />
  );
}

describe('PathBar', () => {
  it('upload button always visible and clickable', () => {
    const onUploadClick = vi.fn();
    renderBar({ onUploadClick });
    fireEvent.click(screen.getByText('上传'));
    expect(onUploadClick).toHaveBeenCalled();
  });

  it('download button hidden when nothing selected', () => {
    renderBar({ selectedCount: 0 });
    expect(screen.queryByText('下载')).not.toBeInTheDocument();
  });

  it('download button shown and calls onDownload when ≥1 selected', () => {
    const onDownload = vi.fn();
    renderBar({ selectedCount: 2, onDownload });
    fireEvent.click(screen.getByText(/下载/));
    expect(onDownload).toHaveBeenCalled();
  });

  it('preview button only when exactly 1 selected and canPreview', () => {
    const onPreview = vi.fn();
    const { rerender } = render(
      <PathBar currentPath="" selectedCount={2} canPreview={true}
        onNavigate={vi.fn()} onRefresh={vi.fn()} onUploadClick={vi.fn()} onPreview={onPreview} onDownload={vi.fn()} />
    );
    expect(screen.queryByText('预览')).not.toBeInTheDocument(); // 多选不给预览
    rerender(
      <PathBar currentPath="" selectedCount={1} canPreview={true}
        onNavigate={vi.fn()} onRefresh={vi.fn()} onUploadClick={vi.fn()} onPreview={onPreview} onDownload={vi.fn()} />
    );
    fireEvent.click(screen.getByText('预览'));
    expect(onPreview).toHaveBeenCalled();
  });

  it('preview button hidden when 1 selected but not previewable', () => {
    renderBar({ selectedCount: 1, canPreview: false });
    expect(screen.queryByText('预览')).not.toBeInTheDocument();
  });
});
