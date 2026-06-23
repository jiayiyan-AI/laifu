import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IMProviderCard } from '../src/apps/im/IMProviderCard.js';
import { IM_PROVIDERS } from '../src/apps/im/providers.js';

const wechat = IM_PROVIDERS.find((p) => p.id === 'wechat')!;
const feishu = IM_PROVIDERS.find((p) => p.id === 'feishu')!;
const noop = vi.fn();

describe('IMProviderCard', () => {
  it('未绑定：显示"绑定"，无"已生效"', () => {
    render(<IMProviderCard provider={wechat} bound={false} onBind={noop} onUnbind={noop} />);
    expect(screen.getByRole('button', { name: '绑定' })).toBeInTheDocument();
    expect(screen.queryByText('已生效')).not.toBeInTheDocument();
  });
  it('已绑定：显示"已生效" + "解绑"', () => {
    render(<IMProviderCard provider={wechat} bound boundAt={new Date().toISOString()} onBind={noop} onUnbind={noop} />);
    expect(screen.getByText('已生效')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '解绑' })).toBeInTheDocument();
  });
  it('飞书 available：显示"绑定"按钮', () => {
    render(<IMProviderCard provider={feishu} bound={false} onBind={noop} onUnbind={noop} />);
    expect(screen.getByRole('button', { name: '绑定' })).toBeInTheDocument();
    expect(screen.queryByText('即将上线')).not.toBeInTheDocument();
  });
});
