import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WithStore } from '../src/atom/index.js';
import * as api from '../src/lib/api.js';
import { Onboarding } from '../src/onboarding/Onboarding.js';

vi.mock('../src/lib/api.js', async (orig) => ({
  ...(await orig<typeof api>()),
  me: vi.fn().mockResolvedValue({ user_id: 'u1', provider: 'dev', external_id: 'x', email: null, nickname: 'n', avatar_url: null, email_domain: 'mail.laifu.uncagedai.org' }),
  status: vi.fn().mockResolvedValue(null),
  purchase: vi.fn().mockResolvedValue({ user_id: 'u1', status: 'provisioning' }),
}));

const renderIt = () => render(<WithStore><Onboarding onReady={() => {}} /></WithStore>);

describe('Onboarding 起名', () => {
  beforeEach(() => vi.clearAllMocks());

  it('名字为空时激活按钮 disabled', async () => {
    renderIt();
    expect(await screen.findByRole('button', { name: /确认支付并激活/ })).toBeDisabled();
  });

  it('输入名字 → 邮箱预览实时变化 + 按钮可点', async () => {
    renderIt();
    const input = await screen.findByPlaceholderText(/灵犀.*Aria.*小助/);
    fireEvent.change(input, { target: { value: 'Aria' } });
    expect(screen.getByText(/aria@mail\.laifu\.uncagedai\.org/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /确认支付并激活/ })).toBeEnabled();
  });

  it('点激活 → purchase 带 assistant_name', async () => {
    renderIt();
    const input = await screen.findByPlaceholderText(/灵犀.*Aria.*小助/);
    fireEvent.change(input, { target: { value: '灵犀' } });
    fireEvent.click(screen.getByRole('button', { name: /确认支付并激活/ }));
    expect(api.purchase).toHaveBeenCalledWith({ assistant_name: '灵犀' });
  });
});
