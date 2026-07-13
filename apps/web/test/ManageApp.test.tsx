import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WithStore } from '@lingxi/atom'
import * as api from '../src/lib/api.js';
import { ManageApp } from '../src/apps/manage/ManageApp.js';

vi.mock('../src/lib/api.js', async (orig) => ({
  ...(await orig<typeof api>()),
  me: vi.fn().mockResolvedValue({ user_id: 'u1', provider: 'dev', external_id: 'x', email: null, nickname: '阿强', avatar_url: null, email_domain: 'mail.laifu.uncagedai.org' }),
  status: vi.fn().mockResolvedValue({ status: 'ready', provisioning_step: null, progress_pct: 100, error_message: null, entitlements_desired: [], entitlements_observed: [], container_token_version: 0, assistant_name: 'Aria', assistant_email: 'aria@mail.laifu.uncagedai.org' }),
  getMyWechatBind: vi.fn().mockResolvedValue({ bound: false }),
}));

describe('ManageApp 身份卡', () => {
  it('显示助理名 + 真实邮箱 + 未接入 IM + IM 绑定按钮', async () => {
    render(<WithStore><ManageApp onOpenIM={() => {}} /></WithStore>);
    expect(await screen.findByText('Aria')).toBeInTheDocument();
    expect(screen.getByText('aria@mail.laifu.uncagedai.org')).toBeInTheDocument();
    expect(screen.getByText(/未接入 IM/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /IM 绑定/ })).toBeInTheDocument();
  });
});
