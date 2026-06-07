import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ManageApp } from '../src/apps/manage/ManageApp.js';
import { EntitlementsProvider } from '../src/lib/entitlements-context.js';

vi.mock('../src/lib/api.js', () => ({
  enableFeature: vi.fn(),
  disableFeature: vi.fn(),
  status: vi.fn(),
  getMyWechatBind: vi.fn().mockResolvedValue({ bound: false }),
  AuthError: class extends Error {},
}));
import * as api from '../src/lib/api.js';

vi.mock('../src/auth/AuthContext.js', () => ({
  useAuth: () => ({ status: 'authenticated', user: { nickname: '测试用户' } }),
}));

function setObserved(observed: string[]) {
  vi.mocked(api.status).mockResolvedValue({
    status: 'ready', provisioning_step: null, progress_pct: 100, error_message: null,
    entitlements_desired: observed, entitlements_observed: observed, container_token_version: 1,
  });
}

const renderApp = () =>
  render(<EntitlementsProvider><ManageApp onOpenWechat={vi.fn()} /></EntitlementsProvider>);

describe('ManageApp', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); setObserved([]); });
  afterEach(() => { vi.useRealTimers(); });

  it('装备 tab 默认显示 3 个基线能力,不含云盘', async () => {
    renderApp();
    await waitFor(() => expect(screen.getByText('联网搜索')).toBeInTheDocument());
    expect(screen.getByText('文件读写')).toBeInTheDocument();
    expect(screen.getByText('微信收发')).toBeInTheDocument();
    expect(screen.getByText(/已装备能力 · 3/)).toBeInTheDocument();
  });

  it('切到市场 tab,云盘显示"购买并装备"', async () => {
    renderApp();
    await waitFor(() => expect(screen.getByText('联网搜索')).toBeInTheDocument());
    fireEvent.click(screen.getByText('市场'));
    await waitFor(() => expect(screen.getByText(/购买并装备/)).toBeInTheDocument());
  });

  it('observed 含 cloud:装备 tab 计 4 且有云盘卡', async () => {
    setObserved(['cloud']);
    renderApp();
    await waitFor(() => expect(screen.getByText(/已装备能力 · 4/)).toBeInTheDocument());
    expect(screen.getByText('云盘')).toBeInTheDocument();
  });

  it('「添加能力」按钮切到市场 tab', async () => {
    renderApp();
    await waitFor(() => expect(screen.getByText('联网搜索')).toBeInTheDocument());
    fireEvent.click(screen.getByText(/添加能力/));
    await waitFor(() => expect(screen.getByText(/购买并装备/)).toBeInTheDocument());
  });
});
