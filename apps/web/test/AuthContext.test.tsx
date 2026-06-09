import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { WithStore } from '../src/atom/index.js';
import { authAtom } from '../src/states/auth.atom.js';

const Probe = () => {
  const [state] = authAtom.use();
  if (state.status === 'loading') return <div>loading</div>;
  if (state.status === 'unauthenticated') return <div>unauthed</div>;
  return <div>{state.user.user_id}</div>;
};

describe('auth atom', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('starts loading, then unauthenticated when /me returns 401', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 401 }));
    render(<WithStore><Probe /></WithStore>);
    await waitFor(() => expect(screen.getByText('unauthed')).toBeInTheDocument());
  });

  it('starts loading, then authenticated when /me returns user', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        user_id: 'u1', provider: 'google', external_id: 'g_1',
        email: 'a@b.com', nickname: null, avatar_url: null,
      })),
    );
    render(<WithStore><Probe /></WithStore>);
    await waitFor(() => expect(screen.getByText('u1')).toBeInTheDocument());
  });
});
