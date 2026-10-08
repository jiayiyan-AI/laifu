import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { WithStore } from '@lingxi/atom';
import * as api from '../lib/api.js';
import { ChangePasswordDialog } from './ChangePasswordDialog.js';

const fill = (label: string, v: string) => fireEvent.change(screen.getByPlaceholderText(label), { target: { value: v } });

describe('ChangePasswordDialog', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('两次新密码不一致 → 前端拦截, 不调接口', async () => {
    const spy = vi.spyOn(api, 'changePassword');
    render(<ChangePasswordDialog onClose={vi.fn()} />);
    fill('当前密码', 'oldpass12'); fill('新密码', 'newpass12'); fill('确认新密码', 'newpass13');
    fireEvent.click(screen.getByRole('button', { name: '确认修改' }));
    expect(await screen.findByText('两次输入的新密码不一致')).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it('后端 403 → 显示"当前密码不正确"', async () => {
    vi.spyOn(api, 'changePassword').mockRejectedValue(new api.ApiError(403, 'wrong_password', 'x'));
    render(<ChangePasswordDialog onClose={vi.fn()} />);
    fill('当前密码', 'bad'); fill('新密码', 'newpass12'); fill('确认新密码', 'newpass12');
    fireEvent.click(screen.getByRole('button', { name: '确认修改' }));
    expect(await screen.findByText('当前密码不正确')).toBeInTheDocument();
  });

  it('成功 → 显示成功提示', async () => {
    vi.spyOn(api, 'changePassword').mockResolvedValue({ ok: true });
    render(<ChangePasswordDialog onClose={vi.fn()} />);
    fill('当前密码', 'oldpass12'); fill('新密码', 'newpass12'); fill('确认新密码', 'newpass12');
    fireEvent.click(screen.getByRole('button', { name: '确认修改' }));
    await waitFor(() => expect(screen.getByText('密码已修改，其他设备已退出登录')).toBeInTheDocument());
  });

  it('后端 401 (会话已被吊销) → 不显示错误文案, 触发 auth refresh 让 ProtectedRoute 跳登录', async () => {
    const me = vi.spyOn(api, 'me').mockRejectedValue(new api.AuthError());
    vi.spyOn(api, 'changePassword').mockRejectedValue(new api.ApiError(401, 'unknown', 'session revoked'));
    render(<WithStore><ChangePasswordDialog onClose={vi.fn()} /></WithStore>);
    await waitFor(() => expect(me).toHaveBeenCalledTimes(1)); // atom 初始化时的那次 refresh
    fill('当前密码', 'oldpass12'); fill('新密码', 'newpass12'); fill('确认新密码', 'newpass12');
    fireEvent.click(screen.getByRole('button', { name: '确认修改' }));
    await waitFor(() => expect(me).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/修改失败/)).not.toBeInTheDocument();
    expect(screen.queryByText(/session revoked/)).not.toBeInTheDocument();
  });
});
