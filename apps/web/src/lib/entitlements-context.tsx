import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import * as api from './api.js';

export interface EntitlementsState {
  desired: string[];
  observed: string[];
  tokenVersion: number;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

const initial: EntitlementsState = {
  desired: [],
  observed: [],
  tokenVersion: 0,
  loading: true,
  error: null,
  refetch: async () => { /* default no-op replaced by provider */ },
};

const EntitlementsContext = createContext<EntitlementsState>(initial);

export const EntitlementsProvider = ({ children }: { children: ReactNode }) => {
  const [desired, setDesired] = useState<string[]>([]);
  const [observed, setObserved] = useState<string[]>([]);
  const [tokenVersion, setTokenVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const s = await api.status();
      if (s) {
        setDesired(s.entitlements_desired ?? []);
        setObserved(s.entitlements_observed ?? []);
        setTokenVersion(s.container_token_version ?? 0);
      } else {
        setDesired([]);
        setObserved([]);
        setTokenVersion(0);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refetch(); }, [refetch]);

  const value: EntitlementsState = { desired, observed, tokenVersion, loading, error, refetch };
  return <EntitlementsContext.Provider value={value}>{children}</EntitlementsContext.Provider>;
};

export const useEntitlements = (): EntitlementsState => useContext(EntitlementsContext);
