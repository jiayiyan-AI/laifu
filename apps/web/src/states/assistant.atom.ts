import { useMemo } from 'react';
import { atom } from '../atom/index.js';
import * as api from '../lib/api.js';

export const DEFAULT_ASSISTANT_NAME = '灵犀';

export interface AssistantState {
  name: string | null;    // null = 未拿到/未购买
  email: string | null;   // 真实专属邮箱（含后缀），来自 status.assistant_email
}

interface AssistantActions {
  refresh: () => Promise<void>;
  setName: (name: string) => void;   // 激活成功乐观写名（email 等下次 refresh）
}

export const assistantAtom = atom<AssistantState, AssistantActions>(
  { name: null, email: null },
  (get, set) => {
    const refresh = async () => {
      try {
        const s = await api.status();
        set({ name: s?.assistant_name ?? null, email: s?.assistant_email ?? null });
      } catch { /* 401/网络错误：保持现状 */ }
    };
    const setName = (name: string) => set({ ...get(), name });
    void refresh();
    return { refresh, setName };
  },
);

/** 全局读助理显示名；缺省回退。 */
export const useAssistantName = (): string => {
  const [s] = assistantAtom.use();
  return useMemo(() => s.name?.trim() || DEFAULT_ASSISTANT_NAME, [s.name]);
};
