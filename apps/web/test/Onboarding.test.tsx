import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WithStore } from '@lingxi/atom'
import * as api from '../src/lib/api.js';
import { Onboarding } from '../src/onboarding/Onboarding.js';

vi.mock('../src/lib/api.js', async (orig) => ({
  ...(await orig<typeof api>()),
  me: vi.fn().mockResolvedValue({ user_id: 'u1', provider: 'dev', external_id: 'x', email: null, nickname: 'n', avatar_url: null, email_domain: 'mail.laifu.uncagedai.org' }),
  status: vi.fn().mockResolvedValue(null),
  purchase: vi.fn().mockResolvedValue({ user_id: 'u1', status: 'provisioning' }),
}));

const renderIt = () => render(<WithStore><Onboarding onReady={() => {}} /></WithStore>);
const nameInput = () => screen.findByPlaceholderText(/灵犀.*Aria.*小助/);
const emailInput = () => screen.getByPlaceholderText(/自己起一个/);
const activateBtn = () => screen.getByRole('button', { name: /确认支付并激活/ });

describe('Onboarding 起名 + 自填邮箱', () => {
  beforeEach(() => vi.clearAllMocks());

  it('名字为空时激活按钮 disabled', async () => {
    renderIt();
    expect(await screen.findByRole('button', { name: /确认支付并激活/ })).toBeDisabled();
  });

  it('填名字、邮箱留空 → 按钮可点；purchase 带 assistant_name，email_localpart=undefined', async () => {
    renderIt();
    fireEvent.change(await nameInput(), { target: { value: '灵犀' } });
    expect(activateBtn()).toBeEnabled();
    fireEvent.click(activateBtn());
    expect(api.purchase).toHaveBeenCalledWith({ assistant_name: '灵犀', email_localpart: undefined });
  });

  it('自填邮箱前缀 → 显示 @域名后缀；purchase 带小写化的 localpart（不拼音）', async () => {
    renderIt();
    fireEvent.change(await nameInput(), { target: { value: '灵犀' } });
    fireEvent.change(emailInput(), { target: { value: 'Aria' } });
    expect(screen.getByText('@mail.laifu.uncagedai.org')).toBeInTheDocument();
    fireEvent.click(activateBtn());
    expect(api.purchase).toHaveBeenCalledWith({ assistant_name: '灵犀', email_localpart: 'aria' });
  });

  it('邮箱前缀格式非法 → 按钮 disabled + 格式提示，不发请求', async () => {
    renderIt();
    fireEvent.change(await nameInput(), { target: { value: '灵犀' } });
    fireEvent.change(emailInput(), { target: { value: 'ab' } });   // < 3 位
    expect(activateBtn()).toBeDisabled();
    expect(screen.getByText(/小写字母\/数字开头结尾/)).toBeInTheDocument();
    expect(api.purchase).not.toHaveBeenCalled();
  });
});
