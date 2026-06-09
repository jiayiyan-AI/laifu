import { atom } from '../atom/index.js';

export interface UsageData {
  used_cny_month: number;
  free_quota_cny_month: number;
  balance_cny: number;
  period_start: string;
}

export interface UsageState {
  data: UsageData | null;
  loading: boolean;
}

interface UsageActions {
  refresh: () => Promise<void>;
}

export const usageAtom = atom<UsageState, UsageActions>(
  { data: null, loading: false },
  (_get, set) => {
    const refresh = async () => {
      set((s) => ({ ...s, loading: true }));
      try {
        const resp = await fetch('/api/me/usage', { credentials: 'include' });
        if (resp.ok) {
          set({ data: await resp.json(), loading: false });
        } else {
          set((s) => ({ ...s, loading: false }));
        }
      } catch {
        set((s) => ({ ...s, loading: false }));
      }
    };
    void refresh();
    return { refresh };
  },
);
