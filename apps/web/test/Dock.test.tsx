import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Dock } from '../src/desktop/Dock.js';

describe('Dock', () => {
  it('always shows base apps (chat + manage)', () => {
    render(<Dock onOpen={vi.fn()} openApps={new Set()} entitlements={[]} />);
    // 未购买时 useAssistantName() 回退 '灵犀'（不含"助理"后缀）
    expect(screen.getByTitle('灵犀')).toBeInTheDocument();
    expect(screen.getByTitle('我的助理')).toBeInTheDocument();
  });

  it('hides Files when entitlements does not include cloud', () => {
    render(<Dock onOpen={vi.fn()} openApps={new Set()} entitlements={[]} />);
    expect(screen.queryByTitle('文件')).not.toBeInTheDocument();
  });

  it('shows Files when entitlements includes cloud', () => {
    render(<Dock onOpen={vi.fn()} openApps={new Set()} entitlements={['cloud']} />);
    expect(screen.getByTitle('文件')).toBeInTheDocument();
  });

  it('clicking Files calls onOpen with files id', () => {
    const onOpen = vi.fn();
    render(<Dock onOpen={onOpen} openApps={new Set()} entitlements={['cloud']} />);
    screen.getByTitle('文件').click();
    expect(onOpen).toHaveBeenCalledWith('files');
  });
});
