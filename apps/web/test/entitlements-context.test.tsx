import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { WithStore } from '@lingxi/atom'
import { entitlementsAtom } from '../src/states/entitlements.atom.js';

vi.mock('../src/lib/api.js', () => ({
  status: vi.fn(),
  AuthError: class AuthError extends Error {},
}));

import * as api from '../src/lib/api.js';

function Probe() {
  const [e, { refetch }] = entitlementsAtom.use();
  return (
    <div>
      <span data-testid="loading">{String(e.loading)}</span>
      <span data-testid="desired">{e.desired.join(',')}</span>
      <span data-testid="observed">{e.observed.join(',')}</span>
      <button data-testid="refetch" onClick={() => void refetch()}>refetch</button>
    </div>
  );
}

describe('entitlements atom', () => {
  beforeEach(() => {
    vi.mocked(api.status).mockReset();
  });

  it('loads entitlements on mount', async () => {
    vi.mocked(api.status).mockResolvedValue({
      status: 'ready', provisioning_step: null, progress_pct: 100, error_message: null,
      entitlements_desired: ['cloud'], entitlements_observed: ['cloud'], container_token_version: 1,
    });
    render(<WithStore><Probe /></WithStore>);
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
    expect(screen.getByTestId('desired').textContent).toBe('cloud');
    expect(screen.getByTestId('observed').textContent).toBe('cloud');
  });

  it('handles null status (no container yet) gracefully', async () => {
    vi.mocked(api.status).mockResolvedValue(null as any);
    render(<WithStore><Probe /></WithStore>);
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
    expect(screen.getByTestId('desired').textContent).toBe('');
    expect(screen.getByTestId('observed').textContent).toBe('');
  });

  it('refetch() re-calls api.status', async () => {
    vi.mocked(api.status)
      .mockResolvedValueOnce({
        status: 'ready', provisioning_step: null, progress_pct: 100, error_message: null,
        entitlements_desired: [], entitlements_observed: [], container_token_version: 0,
      })
      .mockResolvedValueOnce({
        status: 'ready', provisioning_step: null, progress_pct: 100, error_message: null,
        entitlements_desired: ['cloud'], entitlements_observed: ['cloud'], container_token_version: 1,
      });
    render(<WithStore><Probe /></WithStore>);
    await waitFor(() => expect(screen.getByTestId('desired').textContent).toBe(''));
    await act(async () => { screen.getByTestId('refetch').click(); });
    await waitFor(() => expect(screen.getByTestId('desired').textContent).toBe('cloud'));
    expect(api.status).toHaveBeenCalledTimes(2);
  });
});
