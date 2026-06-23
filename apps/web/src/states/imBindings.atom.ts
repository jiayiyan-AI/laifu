import { useMemo } from 'react';
import { atom } from '../atom/index.js';
import { getMyWechatBind } from '../lib/api.js';
import type { IMProviderId } from '../apps/im/providers.js';

export type IMBindings = Partial<Record<IMProviderId, boolean>>;
interface IMBindingsActions { refresh: () => Promise<void>; }

export const imBindingsAtom = atom<IMBindings, IMBindingsActions>(
  {},
  (_get, set) => {
    const refresh = async () => {
      let wechat = false;
      try { wechat = (await getMyWechatBind()).bound; } catch { /* 网络错 → 未绑 */ }
      set({ wechat });
    };
    void refresh();
    return { refresh };
  },
);

export const useIMCount = (): number => {
  const [b] = imBindingsAtom.use();
  return useMemo(() => Object.values(b).filter(Boolean).length, [b]);
};
