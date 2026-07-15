import { useMemo } from 'react';
import { atom } from '@lingxi/atom'
import { getMyWechatBind, getMyFeishuBind } from '../lib/api.js';
import type { IMProviderId } from '../apps/im/providers.js';

export type IMBindings = Partial<Record<IMProviderId, boolean>>;
interface IMBindingsActions { refresh: () => Promise<void>; }

export const imBindingsAtom = atom<IMBindings, IMBindingsActions>(
  {},
  (_get, set) => {
    const refresh = async () => {
      let wechat = false;
      let feishu = false;
      try { wechat = (await getMyWechatBind()).bound; } catch { /* 网络错 → 未绑 */ }
      try {
        const info = await getMyFeishuBind();
        // 只有 active 才算"已生效"
        feishu = info.bound && info.status === 'active';
      } catch { /* 网络错 → 未绑 */ }
      set({ wechat, feishu });
    };
    void refresh();
    return { refresh };
  },
);

export const useIMCount = (): number => {
  const [b] = imBindingsAtom.use();
  return useMemo(() => Object.values(b).filter(Boolean).length, [b]);
};
