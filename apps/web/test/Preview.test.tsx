import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Preview } from '../src/apps/files/Preview.js';
import type { FileItem } from '../src/apps/files/types.js';

const mkFile = (over: Partial<FileItem> = {}): FileItem => ({
  virtual_path: 'a.pdf', size: 1, last_modified: 'x', content_type: 'application/pdf',
  title: 'A', session_id: null, source: 'agent', ...over,
});

describe('Preview', () => {
  it('renders an iframe for pdf pointing at inline download url', () => {
    render(<Preview file={mkFile()} onClose={vi.fn()} />);
    const frame = screen.getByTitle('A') as HTMLIFrameElement;
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('src')).toContain('/api/cloud/download?path=a.pdf');
  });

  it('renders an img for image', () => {
    render(<Preview file={mkFile({ virtual_path: 'p.png', content_type: 'image/png', title: 'P' })} onClose={vi.fn()} />);
    const img = screen.getByAltText('P') as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
    expect(img.getAttribute('src')).toContain('/api/cloud/download?path=p.png');
  });

  it('calls onClose on Escape and on backdrop click', () => {
    const onClose = vi.fn();
    render(<Preview file={mkFile()} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('preview-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
