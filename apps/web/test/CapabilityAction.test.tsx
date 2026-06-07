import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { CapabilityEquip, CapabilityRemove } from '../src/apps/manage/CapabilityAction.js';
import { EntitlementsProvider } from '../src/lib/entitlements-context.js';
import { getCapability } from '../src/lib/capabilities.js';

vi.mock('../src/lib/api.js', () => ({
  enableFeature: vi.fn(),
  disableFeature: vi.fn(),
  status: vi.fn(),
  AuthError: class extends Error {},
}));
import * as api from '../src/lib/api.js';

const CLOUD = getCapability('cloud')!;

function setObserved(observed: string[]) {
  vi.mocked(api.status).mockResolvedValue({
    status: 'ready', provisioning_step: null, progress_pct: 100, error_message: null,
    entitlements_desired: observed, entitlements_observed: observed, container_token_version: 1,
  });
}

describe('CapabilityEquip', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setObserved([]);
    vi.mocked(api.enableFeature).mockReset();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('未装备时显示"购买并装备"', async () => {
    render(<EntitlementsProvider><CapabilityEquip cap={CLOUD} /></EntitlementsProvider>);
    await waitFor(() => expect(screen.getByText(/购买并装备/)).toBeInTheDocument());
  });

  it('observed 含 cloud 时显示"已装备"', async () => {
    setObserved(['cloud']);
    render(<EntitlementsProvider><CapabilityEquip cap={CLOUD} /></EntitlementsProvider>);
    await waitFor(() => expect(screen.getByText(/已装备/)).toBeInTheDocument());
  });

  it('确认框点取消 → 回 idle,不调 API', async () => {
    render(<EntitlementsProvider><CapabilityEquip cap={CLOUD} /></EntitlementsProvider>);
    await waitFor(() => expect(screen.getByText(/购买并装备/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/购买并装备/));
    await waitFor(() => expect(screen.getByText(/确认购买并装备/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/取消/));
    await waitFor(() => expect(screen.queryByText(/价格: 免费/)).not.toBeInTheDocument());
    expect(api.enableFeature).not.toHaveBeenCalled();
  });

  it('确认后调 enableFeature(cloud) 并轮询到 observed 后 onReady', async () => {
    vi.mocked(api.enableFeature).mockResolvedValue({ ok: true, entitlements: ['cloud'], changed: true });
    vi.mocked(api.status)
      .mockResolvedValueOnce({
        status: 'ready', provisioning_step: null, progress_pct: 100, error_message: null,
        entitlements_desired: [], entitlements_observed: [], container_token_version: 0,
      })
      .mockResolvedValue({
        status: 'ready', provisioning_step: null, progress_pct: 100, error_message: null,
        entitlements_desired: ['cloud'], entitlements_observed: ['cloud'], container_token_version: 1,
      });
    const onReady = vi.fn();
    render(<EntitlementsProvider><CapabilityEquip cap={CLOUD} onReady={onReady} /></EntitlementsProvider>);
    await waitFor(() => expect(screen.getByText(/购买并装备/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/购买并装备/));
    await waitFor(() => expect(screen.getByText(/确认购买并装备/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/确认购买并装备/));
    await waitFor(() => expect(screen.getByText(/正在记录订单|正在装备到助理/)).toBeInTheDocument());
    for (let i = 0; i < 5; i++) { await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); }
    await waitFor(() => expect(onReady).toHaveBeenCalled());
    expect(api.enableFeature).toHaveBeenCalledWith('cloud');
  });
});

describe('CapabilityRemove', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setObserved(['cloud']);
    vi.mocked(api.disableFeature).mockReset();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('点 trigger → 确认框;确认后调 disableFeature(cloud)', async () => {
    vi.mocked(api.disableFeature).mockResolvedValue({ ok: true, entitlements: [], changed: true });
    render(
      <EntitlementsProvider>
        <CapabilityRemove cap={CLOUD} trigger={(open) => <button onClick={open}>✕</button>} />
      </EntitlementsProvider>
    );
    fireEvent.click(screen.getByText('✕'));
    await waitFor(() => expect(screen.getByText(/退订云盘/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/确认退订/));
    await waitFor(() => expect(api.disableFeature).toHaveBeenCalledWith('cloud'));
  });

  it('确认框点取消 → 不调 disableFeature', async () => {
    render(
      <EntitlementsProvider>
        <CapabilityRemove cap={CLOUD} trigger={(open) => <button onClick={open}>✕</button>} />
      </EntitlementsProvider>
    );
    fireEvent.click(screen.getByText('✕'));
    await waitFor(() => expect(screen.getByText(/退订云盘/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/取消/));
    await waitFor(() => expect(screen.queryByText(/确认退订/)).not.toBeInTheDocument());
    expect(api.disableFeature).not.toHaveBeenCalled();
  });

  it('退订后轮询到 observed 不含 cloud → 弹窗关闭', async () => {
    vi.mocked(api.disableFeature).mockResolvedValue({ ok: true, entitlements: [], changed: true });
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
      <EntitlementsProvider>
        <CapabilityRemove cap={CLOUD} trigger={(open) => <button onClick={open}>✕</button>} />
      </EntitlementsProvider>
    );
    fireEvent.click(screen.getByText('✕'));
    await waitFor(() => expect(screen.getByText(/退订云盘/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/确认退订/));
    await waitFor(() => expect(api.disableFeature).toHaveBeenCalledWith('cloud'));
    for (let i = 0; i < 5; i++) { await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); }
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    await waitFor(() => expect(screen.queryByText(/正在卸载/)).not.toBeInTheDocument());
  });
});
