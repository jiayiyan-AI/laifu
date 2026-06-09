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

function setObserved(observed: string[]) {
  vi.mocked(api.status).mockResolvedValue({
    status: 'ready', provisioning_step: null, progress_pct: 100, error_message: null,
    entitlements_desired: observed, entitlements_observed: observed, container_token_version: 1,
  });
}

describe('BuyCloudButton', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); setObserved([]); vi.mocked(api.enableCloud).mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it('shows "购买并装备" when cloud not active', async () => {
    render(
      <WithStore>
        <BuyCloudButton onReady={vi.fn()} />
      </WithStore>
    );
    await waitFor(() => expect(screen.getByText(/购买并装备/)).toBeInTheDocument());
  });

  it('shows "已装备" when cloud is in observed', async () => {
    setObserved(['cloud']);
    render(
      <WithStore>
        <BuyCloudButton onReady={vi.fn()} />
      </WithStore>
    );
    await waitFor(() => expect(screen.getByText(/已装备/)).toBeInTheDocument());
  });

  it('clicking 取消 in confirm modal returns to idle without API call', async () => {
    render(
      <WithStore>
        <BuyCloudButton onReady={vi.fn()} />
      </WithStore>
    );
    await waitFor(() => expect(screen.getByText(/购买并装备/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/购买并装备/));
    await waitFor(() => expect(screen.getByText(/确认购买并装备/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/取消/));
    await waitFor(() => expect(screen.queryByText(/价格: 免费/)).not.toBeInTheDocument());
    expect(api.enableCloud).not.toHaveBeenCalled();
  });

  it('clicking the button opens confirm modal then polls after confirming', async () => {
    vi.mocked(api.enableCloud).mockResolvedValue({ ok: true, entitlements: ['cloud'], changed: true });
    vi.mocked(api.status)
      .mockResolvedValueOnce({
        status: 'ready', provisioning_step: null, progress_pct: 100, error_message: null,
        entitlements_desired: [], entitlements_observed: [], container_token_version: 0,
      })
      .mockResolvedValueOnce({
        status: 'ready', provisioning_step: null, progress_pct: 100, error_message: null,
        entitlements_desired: ['cloud'], entitlements_observed: [], container_token_version: 1,
      })
      .mockResolvedValue({
        status: 'ready', provisioning_step: null, progress_pct: 100, error_message: null,
        entitlements_desired: ['cloud'], entitlements_observed: ['cloud'], container_token_version: 1,
      });
    const onReady = vi.fn();
    render(
      <WithStore>
        <BuyCloudButton onReady={onReady} />
      </WithStore>
    );
    await waitFor(() => expect(screen.getByText(/购买并装备/)).toBeInTheDocument());

    fireEvent.click(screen.getByText(/购买并装备/));   // opens confirm modal
    await waitFor(() => expect(screen.getByText(/确认购买并装备/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/确认购买并装备/));  // proceed to posting

    await waitFor(() => expect(screen.getByText(/正在记录订单|正在装备到助理/)).toBeInTheDocument());

    for (let i = 0; i < 5; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    }

    await waitFor(() => expect(onReady).toHaveBeenCalled());
  });
});
