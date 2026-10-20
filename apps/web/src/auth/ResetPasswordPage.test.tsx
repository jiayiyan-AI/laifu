import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as api from '../lib/api.js';
import { ResetPasswordPage } from './ResetPasswordPage.js';

const renderAt = (url: string) => render(
  <MemoryRouter initialEntries={[url]}>
    <Routes>
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/login" element={<div>LOGIN_PAGE</div>} />
    </Routes>
  </MemoryRouter>,
);
const fill = (label: string, v: string) => fireEvent.change(screen.getByPlaceholderText(label), { target: { value: v } });

describe('ResetPasswordPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('URL 无 token → 直接提示链接无效 + 重新申请入口', () => {
    renderAt('/reset-password');
    expect(screen.getByText('链接无效或已过期')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '重新申请' })).toHaveAttribute('href', '/forgot-password');
  });

  it('成功 → 带 token 调接口并跳登录页', async () => {
    const spy = vi.spyOn(api, 'resetPassword').mockResolvedValue({ ok: true });
    renderAt('/reset-password?token=tok1');
    fill('新密码', 'newpass12'); fill('确认新密码', 'newpass12');
    fireEvent.click(screen.getByRole('button', { name: '设置新密码' }));
    expect(await screen.findByText('LOGIN_PAGE')).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith({ token: 'tok1', new_password: 'newpass12' });
  });

  it('token 过期 → 显示错误 + 重新申请', async () => {
    vi.spyOn(api, 'resetPassword').mockRejectedValue(new api.ApiError(400, 'invalid_or_expired_token', 'x'));
    renderAt('/reset-password?token=tok1');
    fill('新密码', 'newpass12'); fill('确认新密码', 'newpass12');
    fireEvent.click(screen.getByRole('button', { name: '设置新密码' }));
    expect(await screen.findByText('链接无效或已过期')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '重新申请' })).toBeInTheDocument();
  });
});
