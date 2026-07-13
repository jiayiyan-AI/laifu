import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { LoginPage } from '../src/auth/LoginPage.js';
import { WithStore } from '@lingxi/atom'
import * as api from '../src/lib/api.js';
import * as tauriCore from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: vi.fn(() => false),
  invoke: vi.fn(),
}));

const wrap = (ui: ReactNode) => (
  <MemoryRouter><WithStore>{ui}</WithStore></MemoryRouter>
);

describe('LoginPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 401 }));
  });

  it('默认登录态: 显示邮箱/密码输入 + 登录按钮', async () => {
    render(wrap(<LoginPage />));
    await waitFor(() => {
      expect(screen.getByPlaceholderText('邮箱')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('密码')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '登录' })).toBeInTheDocument();
    });
  });

  it('切到注册态: 仍是邮箱/密码,主按钮变"注册并进入"(不再要求称呼)', async () => {
    render(wrap(<LoginPage />));
    await waitFor(() => screen.getByText('注册'));
    fireEvent.click(screen.getByRole('button', { name: '注册' }));
    expect(screen.queryByPlaceholderText('你的称呼')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('邮箱')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '注册并进入' })).toBeInTheDocument();
  });

  it('提交登录调 api.login', async () => {
    const loginSpy = vi.spyOn(api, 'login').mockResolvedValue({
      user_id: 'u1', provider: 'password', external_id: 'a@b.com',
      email: 'a@b.com', nickname: 'Qiang', avatar_url: null,
    });
    render(wrap(<LoginPage />));
    await waitFor(() => screen.getByPlaceholderText('邮箱'));
    fireEvent.change(screen.getByPlaceholderText('邮箱'), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByPlaceholderText('密码'), { target: { value: 'secret12' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    await waitFor(() => {
      expect(loginSpy).toHaveBeenCalledWith({ email: 'a@b.com', password: 'secret12' });
    });
  });

  it('登录失败显示错误文案', async () => {
    vi.spyOn(api, 'login').mockRejectedValue(new Error('boom'));
    render(wrap(<LoginPage />));
    await waitFor(() => screen.getByPlaceholderText('邮箱'));
    fireEvent.change(screen.getByPlaceholderText('邮箱'), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByPlaceholderText('密码'), { target: { value: 'secret12' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    await waitFor(() => {
      expect(screen.getByText(/邮箱或密码错误|登录失败/)).toBeInTheDocument();
    });
  });

  it('Google 入口(下方)默认走浏览器同页跳转 /api/auth/google/start', async () => {
    render(wrap(<LoginPage />));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Google/ })).toBeInTheDocument();
    });
    const originalHref = window.location.href;
    // jsdom 不实现真实导航；断言赋值本身发生即可证明走的是同页跳转分支。
    let assignedHref: string | undefined;
    Object.defineProperty(window, 'location', {
      value: { ...window.location, set href(v: string) { assignedHref = v; } },
      writable: true,
    });
    fireEvent.click(screen.getByRole('button', { name: /Google/ }));
    expect(assignedHref).toBe('/api/auth/google/start');
    window.history.replaceState({}, '', originalHref);
  });

  it('Tauri 环境下点 Google 走系统浏览器（invoke open_oauth_in_browser），不做同页跳转', async () => {
    vi.mocked(tauriCore.isTauri).mockReturnValue(true);
    render(wrap(<LoginPage />));
    await waitFor(() => screen.getByRole('button', { name: /Google/ }));
    fireEvent.click(screen.getByRole('button', { name: /Google/ }));
    expect(tauriCore.invoke).toHaveBeenCalledWith('open_oauth_in_browser', { provider: 'google' });
  });
});
