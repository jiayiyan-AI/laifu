import { atom } from '@lingxi/atom'
import type { AuthMeResponse } from '@lingxi/shared';
import * as api from '../lib/api.js';

export type AuthState =
  | { status: 'loading' }
  | { status: 'unauthenticated' }
  | { status: 'authenticated'; user: AuthMeResponse };

interface AuthActions {
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

export const authAtom = atom<AuthState, AuthActions>(
  { status: 'loading' },
  (_get, set) => {
    const refresh = async () => {
      try {
        const user = await api.me();
        set({ status: 'authenticated', user });
      } catch {
        set({ status: 'unauthenticated' });
      }
    };
    const logout = async () => {
      try { await api.logout(); } catch { /* ignore */ }
      set({ status: 'unauthenticated' });
    };
    void refresh();
    return { refresh, logout };
  },
);
