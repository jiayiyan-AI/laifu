import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { DisableCloudButton } from '../src/apps/manage/DisableCloudButton.js';
import { WithStore } from '@lingxi/atom'

vi.mock('../src/lib/api.js', () => ({
  disableCloud: vi.fn(),
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

describe('DisableCloudButton', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); setObserved(['cloud']); vi.mocked(api.disableCloud).mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it('renders trigger and opens confirm on click', async () => {
    render(
      <WithStore>
        <DisableCloudButton trigger={(open) => <button data-testid="t" onClick={open}>X</button>} />
      </WithStore>
    );
    fireEvent.click(screen.getByTestId('t'));
    await waitFor(() => expect(screen.getByText(/退订云盘/)).toBeInTheDocument());
    expect(screen.getByText(/确认退订/)).toBeInTheDocument();
  });

  it('cancel button returns to idle without API call', async () => {
    render(
      <WithStore>
        <DisableCloudButton trigger={(open) => <button data-testid="t" onClick={open}>X</button>} />
      </WithStore>
    );
    fireEvent.click(screen.getByTestId('t'));
    await waitFor(() => expect(screen.getByText(/确认退订/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/取消/));
    await waitFor(() => expect(screen.queryByText(/确认退订/)).not.toBeInTheDocument());
    expect(api.disableCloud).not.toHaveBeenCalled();
  });

  it('confirm → posting → polls until observed clears', async () => {
    vi.mocked(api.disableCloud).mockResolvedValue({ ok: true, entitlements: [], changed: true });
    // first status: still has cloud, subsequent: empty
    vi.mocked(api.status)
      .mockResolvedValueOnce({
        status: 'ready', provisioning_step: null, progress_pct: 100, error_message: null,
        entitlements_desired: ['cloud'], entitlements_observed: ['cloud'], container_token_version: 1,
      })
      .mockResolvedValue({
        status: 'ready', provisioning_step: null, progress_pct: 100, error_message: null,
        entitlements_desired: [], entitlements_observed: [], container_token_version: 2,
      });

    render(
      <WithStore>
        <DisableCloudButton trigger={(open) => <button data-testid="t" onClick={open}>X</button>} />
      </WithStore>
    );
    fireEvent.click(screen.getByTestId('t'));
    await waitFor(() => expect(screen.getByText(/确认退订/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/确认退订/));

    for (let i = 0; i < 5; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    }

    await waitFor(() => {
      // modal eventually closes after 'done' phase
      expect(screen.queryByText(/正在卸载/)).not.toBeInTheDocument();
    }, { timeout: 10000 });

    expect(api.disableCloud).toHaveBeenCalled();
  });
});
