import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { LoginPage } from '../src/auth/LoginPage.js';
import { AuthProvider } from '../src/auth/AuthContext.js';

const wrap = (ui: ReactNode) => (
  <MemoryRouter><AuthProvider>{ui}</AuthProvider></MemoryRouter>
);

describe('LoginPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders WeChat button and dev login form', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 401 }));
    render(wrap(<LoginPage />));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /微信扫码/ })).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/wx_unionid/i)).toBeInTheDocument();
    });
  });

  it('submits dev login and triggers auth', async () => {
    const user = userEvent.setup();
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 401 }))   // initial /me
      .mockResolvedValueOnce(new Response(JSON.stringify({
        user_id: 'u1', wx_unionid: 'wx_demo', nickname: 'Demo', avatar_url: null,
      })));   // devLogin

    render(wrap(<LoginPage />));
    await waitFor(() => screen.getByPlaceholderText(/wx_unionid/i));

    const unionidInput = screen.getByPlaceholderText(/wx_unionid/i);
    const nicknameInput = screen.getByPlaceholderText(/称呼/);

    // The plan pre-fills the inputs with defaults; clear before typing
    await user.clear(unionidInput);
    await user.type(unionidInput, 'wx_demo');
    await user.clear(nicknameInput);
    await user.type(nicknameInput, 'Demo');
    await user.click(screen.getByRole('button', { name: /^登录$/ }));

    const calls = (global.fetch as any).mock.calls;
    const loginCall = calls.find((c: any) => c[0] === '/api/auth/dev/login');
    expect(loginCall).toBeDefined();
    expect(loginCall[1].body).toContain('wx_demo');
  });
});
