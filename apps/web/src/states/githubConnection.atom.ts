import { atom } from '@lingxi/atom'
import { getGithubConnection } from '../lib/api.js';
import type { GithubConnectionResponse } from '@lingxi/shared';

export type GithubState =
  | { status: 'loading' }
  | { status: 'ready'; conn: GithubConnectionResponse };

interface GithubActions {
  refresh: () => Promise<void>;
}

export const githubConnectionAtom = atom<GithubState, GithubActions>(
  { status: 'loading' },
  (_get, set) => {
    const refresh = async () => {
      try {
        const conn = await getGithubConnection();
        set({ status: 'ready', conn });
      } catch {
        // 网络错 / 未登录 → 当作未连接展示
        set({ status: 'ready', conn: { connected: false } });
      }
    };
    void refresh();
    return { refresh };
  },
);
