import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth } from '../src/auth/AuthContext.js';

const Probe = () => {
  const auth = useAuth();
  if (auth.status === 'loading') return <div>loading</div>;
  if (auth.status === 'unauthenticated') return <div>unauthed</div>;
  return <div>{auth.user.user_id}</div>;
};

describe('AuthContext', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('starts loading, then unauthenticated when /me returns 401', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 401 }));
    render(<AuthProvider><Probe /></AuthProvider>);
    expect(screen.getByText('loading')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('unauthed')).toBeInTheDocument());
  });

  it('starts loading, then authenticated when /me returns user', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        user_id: 'u1', provider: 'google', external_id: 'g_1',
        email: 'a@b.com', nickname: null, avatar_url: null,
      })),
    );
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByText('u1')).toBeInTheDocument());
  });
});
