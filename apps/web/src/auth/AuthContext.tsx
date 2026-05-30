import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { AuthMeResponse, DevLoginRequest } from '@lingxi/shared';
import * as api from '../lib/api.js';

type AuthState =
  | { status: 'loading' }
  | { status: 'unauthenticated' }
  | { status: 'authenticated'; user: AuthMeResponse };

interface AuthCtx {
  status: AuthState['status'];
  user?: AuthMeResponse;
  devLogin: (body: DevLoginRequest) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  const refresh = async () => {
    try {
      const user = await api.me();
      setState({ status: 'authenticated', user });
    } catch {
      setState({ status: 'unauthenticated' });
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const devLogin = async (body: DevLoginRequest) => {
    const user = await api.devLogin(body);
    setState({ status: 'authenticated', user });
  };

  const logout = async () => {
    try { await api.logout(); } catch { /* ignore */ }
    setState({ status: 'unauthenticated' });
  };

  return (
    <Ctx.Provider value={{
      status: state.status,
      user: state.status === 'authenticated' ? state.user : undefined,
      devLogin,
      logout,
      refresh,
    }}>
      {children}
    </Ctx.Provider>
  );
};

interface UseAuthLoading { status: 'loading' }
interface UseAuthUnauthed { status: 'unauthenticated'; devLogin: AuthCtx['devLogin'] }
interface UseAuthAuthed {
  status: 'authenticated';
  user: AuthMeResponse;
  logout: AuthCtx['logout'];
  refresh: AuthCtx['refresh'];
  devLogin: AuthCtx['devLogin'];
}

export const useAuth = (): UseAuthLoading | UseAuthUnauthed | UseAuthAuthed => {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  if (ctx.status === 'loading') return { status: 'loading' };
  if (ctx.status === 'unauthenticated') return { status: 'unauthenticated', devLogin: ctx.devLogin };
  return {
    status: 'authenticated',
    user: ctx.user!,
    logout: ctx.logout,
    refresh: ctx.refresh,
    devLogin: ctx.devLogin,
  };
};
