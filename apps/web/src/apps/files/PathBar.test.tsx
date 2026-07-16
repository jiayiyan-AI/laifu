import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PathBar } from './PathBar.js';

function props(onShowSyncFlyout?: () => void) {
  return {
    currentPath: '',
    selectedCount: 0,
    canPreview: false,
    onNavigate: vi.fn(),
    onRefresh: vi.fn(),
    onUploadClick: vi.fn(),
    onPreview: vi.fn(),
    onDownload: vi.fn(),
    onShowSyncFlyout,
  };
}

describe('PathBar sync status action', () => {
  it('is absent without a native flyout handler', () => {
    render(<PathBar {...props()} />);

    expect(screen.queryByRole('button', { name: '同步状态' })).not.toBeInTheDocument();
  });

  it('invokes the tray-anchored flyout action', () => {
    const showSyncFlyout = vi.fn();
    render(<PathBar {...props(showSyncFlyout)} />);

    fireEvent.click(screen.getByRole('button', { name: '同步状态' }));

    expect(showSyncFlyout).toHaveBeenCalledOnce();
  });
});
