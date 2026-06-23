import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { BuyCloudButton } from '../src/apps/manage/BuyCloudButton.js';
import { WithStore } from '../src/atom/index.js';

vi.mock('../src/lib/api.js', () => ({
  enableCloud: vi.fn(),
  status: vi.fn(),
  AuthError: class extends Error {},
}));
import * as api from '../src/lib/api.js';

const statusWith = (observed: string[]) => ({
  status: 'ready' as const, provisioning_step: null, progress_pct: 100, error_message: null,
  entitlements_desired: observed, entitlements_observed: observed, container_token_version: 1,
});

describe('BuyCloudButton', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.enableCloud).mockReset();
    vi.mocked(api.status).mockResolvedValue(statusWith([]));
  });
  afterEach(() => { vi.useRealTimers(); });

  it('confirm → polling shows blocking copy → observed flips → ✓ 已装备', async () => {
    vi.mocked(api.enableCloud).mockResolvedValue({ ok: true, entitlements: ['cloud'], changed: true });
    vi.mocked(api.status)
      .mockResolvedValueOnce(statusWith([]))
      .mockResolvedValue(statusWith(['cloud']));

    render(<WithStore><BuyCloudButton onReady={() => {}} /></WithStore>);
    fireEvent.click(screen.getByText('购买并装备'));
    await waitFor(() => expect(screen.getByText('确认购买并装备')).toBeInTheDocument());
    fireEvent.click(screen.getByText('确认购买并装备'));

    await waitFor(() => expect(screen.getByText(/正在装备到助理/)).toBeInTheDocument());
    expect(screen.getByText(/约需 1 分钟/)).toBeInTheDocument();

    for (let i = 0; i < 3; i++) { await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); }
    await waitFor(() => expect(screen.getByText('✓ 已装备')).toBeInTheDocument());
  });

  it('observed never flips → after 180s shows 装备失败 + 重试 (not before)', async () => {
    vi.mocked(api.enableCloud).mockResolvedValue({ ok: true, entitlements: ['cloud'], changed: true });
    vi.mocked(api.status).mockResolvedValue(statusWith([])); // never flips

    render(<WithStore><BuyCloudButton onReady={() => {}} /></WithStore>);
    fireEvent.click(screen.getByText('购买并装备'));
    await waitFor(() => expect(screen.getByText('确认购买并装备')).toBeInTheDocument());
    fireEvent.click(screen.getByText('确认购买并装备'));
    await waitFor(() => expect(screen.getByText(/正在装备到助理/)).toBeInTheDocument());

    // 30s 时仍在装备 (旧的 30s 判死已删)
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.queryByText(/装备失败/)).not.toBeInTheDocument();

    // 跨过 180s → 失败
    await act(async () => { await vi.advanceTimersByTimeAsync(151_000); });
    await waitFor(() => expect(screen.getByText(/装备失败/)).toBeInTheDocument());
    expect(screen.getByText('立即重试')).toBeInTheDocument();
  });

  it('enableCloud throws → 购买失败', async () => {
    vi.mocked(api.enableCloud).mockRejectedValue(new Error('网络炸了'));
    render(<WithStore><BuyCloudButton onReady={() => {}} /></WithStore>);
    fireEvent.click(screen.getByText('购买并装备'));
    await waitFor(() => expect(screen.getByText('确认购买并装备')).toBeInTheDocument());
    fireEvent.click(screen.getByText('确认购买并装备'));
    await waitFor(() => expect(screen.getByText('购买失败')).toBeInTheDocument());
  });
});
