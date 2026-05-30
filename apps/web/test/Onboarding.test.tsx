import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Onboarding } from '../src/onboarding/Onboarding.js';

describe('Onboarding', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows purchase CTA when /api/status returns 404', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(null, { status: 404 }));
    render(<Onboarding onReady={() => {}} />);
    await waitFor(() => screen.getByRole('button', { name: /购买并激活/ }));
  });

  it('shows progress when status is provisioning, calls onReady when ready', async () => {
    const onReady = vi.fn();
    const sequence = [
      new Response(JSON.stringify({ status: 'provisioning', provisioning_step: '正在创建账户与订单', progress_pct: 5, error_message: null })),
      new Response(JSON.stringify({ status: 'provisioning', provisioning_step: '装载基础知识库', progress_pct: 90, error_message: null })),
      new Response(JSON.stringify({ status: 'ready', provisioning_step: '灵犀助理上岗完成', progress_pct: 100, error_message: null })),
    ];
    let idx = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => sequence[idx++]!);

    render(<Onboarding onReady={onReady} />);
    await waitFor(() => expect(screen.getByText(/正在创建账户与订单/)).toBeInTheDocument(), { timeout: 3000 });
    await waitFor(() => expect(onReady).toHaveBeenCalled(), { timeout: 5000 });
  });

  it('purchase button triggers POST /api/purchase', async () => {
    const user = userEvent.setup();
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user_id: 'u1', status: 'provisioning' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'provisioning', provisioning_step: '正在创建账户与订单', progress_pct: 5, error_message: null })));

    render(<Onboarding onReady={() => {}} />);
    await user.click(await screen.findByRole('button', { name: /购买并激活/ }));

    const calls = (global.fetch as any).mock.calls;
    expect(calls.some((c: any) => c[0] === '/api/purchase')).toBe(true);
  });
});
