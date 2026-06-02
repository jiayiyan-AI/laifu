import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { EnableCloudButton } from '../src/apps/manage/EnableCloudButton.js';
import { EntitlementsProvider } from '../src/lib/entitlements-context.js';

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

describe('EnableCloudButton', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); setObserved([]); vi.mocked(api.enableCloud).mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it('shows "启用云盘" when cloud not active', async () => {
    render(
      <EntitlementsProvider>
        <EnableCloudButton onReady={vi.fn()} />
      </EntitlementsProvider>
    );
    await waitFor(() => expect(screen.getByText(/启用云盘/)).toBeInTheDocument());
  });

  it('shows "已启用" when cloud is in observed', async () => {
    setObserved(['cloud']);
    render(
      <EntitlementsProvider>
        <EnableCloudButton onReady={vi.fn()} />
      </EntitlementsProvider>
    );
    await waitFor(() => expect(screen.getByText(/已启用/)).toBeInTheDocument());
  });

  it('clicking the button opens Modal in "posting" state then polls', async () => {
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
      <EntitlementsProvider>
        <EnableCloudButton onReady={onReady} />
      </EntitlementsProvider>
    );
    await waitFor(() => expect(screen.getByText(/启用云盘/)).toBeInTheDocument());

    fireEvent.click(screen.getByText(/启用云盘/));
    await waitFor(() => expect(screen.getByText(/正在启用|启用中|助理重启中|正在记录/)).toBeInTheDocument());

    for (let i = 0; i < 5; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    }

    await waitFor(() => expect(onReady).toHaveBeenCalled());
  });
});
