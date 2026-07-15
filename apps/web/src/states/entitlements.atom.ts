import { atom } from '@lingxi/atom'
import * as api from '../lib/api.js';

export interface EntitlementsData {
  desired: string[];
  observed: string[];
  tokenVersion: number;
  loading: boolean;
  error: Error | null;
}

interface EntitlementsActions {
  refetch: () => Promise<void>;
}

export const entitlementsAtom = atom<EntitlementsData, EntitlementsActions>(
  { desired: [], observed: [], tokenVersion: 0, loading: true, error: null },
  (_get, set) => {
    const refetch = async () => {
      set((s) => ({ ...s, loading: true }));
      try {
        const s = await api.status();
        if (s) {
          set({ desired: s.entitlements_desired ?? [], observed: s.entitlements_observed ?? [], tokenVersion: s.container_token_version ?? 0, loading: false, error: null });
        } else {
          set({ desired: [], observed: [], tokenVersion: 0, loading: false, error: null });
        }
      } catch (err) {
        set((prev) => ({ ...prev, loading: false, error: err instanceof Error ? err : new Error(String(err)) }));
      }
    };
    void refetch();
    return { refetch };
  },
);
