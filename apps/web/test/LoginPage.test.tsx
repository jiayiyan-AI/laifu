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

  it('shows Google login CTA pointing to /api/auth/google/start', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 401 }));
    render(wrap(<LoginPage />));
    await waitFor(() => {
      const link = screen.getByRole('link', { name: /Google/ });
      expect(link).toBeInTheDocument();
      expect(link.getAttribute('href')).toBe('/api/auth/google/start');
    });
  });

  it('dev login lives inside collapsed <details>', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 401 }));
    render(wrap(<LoginPage />));
    // 默认折叠,所以 external_id input 是 hidden 直到展开
    await waitFor(() => {
      expect(screen.getByText(/开发者快捷登录/)).toBeInTheDocument();
    });
  });

  it('submits dev login with {external_id, nickname}', async () => {
    const user = userEvent.setup();
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 401 }))   // initial /me
      .mockResolvedValueOnce(new Response(JSON.stringify({
        user_id: 'u1', provider: 'dev', external_id: 'alice',
        email: null, nickname: 'Alice', avatar_url: null,
      })));   // devLogin

    render(wrap(<LoginPage />));
    await waitFor(() => screen.getByText(/开发者快捷登录/));
    // 展开 <details>
    await user.click(screen.getByText(/开发者快捷登录/));

    const idInput = await screen.findByPlaceholderText(/external_id/i);
    await user.clear(idInput);
    await user.type(idInput, 'alice');
    await user.click(screen.getByRole('button', { name: /dev 身份登录/ }));

    const calls = (global.fetch as any).mock.calls;
    const loginCall = calls.find((c: any) => c[0] === '/api/auth/dev/login');
    expect(loginCall).toBeDefined();
    const body = JSON.parse(loginCall[1].body);
    expect(body.external_id).toBe('alice');
  });
});
