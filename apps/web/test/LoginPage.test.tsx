import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { LoginPage } from '../src/auth/LoginPage.js';
import { WithStore } from '../src/atom/index.js';
import * as api from '../src/lib/api.js';

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

  it('Google 入口仍在(下方),指向 /api/auth/google/start', async () => {
    render(wrap(<LoginPage />));
    await waitFor(() => {
      const link = screen.getByRole('link', { name: /Google/ });
      expect(link.getAttribute('href')).toBe('/api/auth/google/start');
    });
  });
});
