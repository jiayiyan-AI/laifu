import { atom } from '@lingxi/atom';
import { isAuthed, openLogin, logout, onAuthed, onLoginCancelled, onLoginFailed } from '@/lib/ipc';

export type AuthPhase = 'unknown' | 'authed' | 'unauthed';

export interface AuthData {
  phase: AuthPhase;
  error: string | null;
  loggingIn: boolean;
}

const INITIAL: AuthData = { phase: 'unknown', error: null, loggingIn: false };

/**
 * 登录态 atom。异步初始化：首次被订阅时查 keychain（is_authed），并挂 Rust 事件监听：
 *   - "authed"          登录成功 → phase=authed
 *   - "login-cancelled" 用户关登录窗未完成 → 复位 loggingIn（否则按钮永久卡"登录中…"）
 *   - "login-failed"    换 token 失败 → 复位 loggingIn + 显错
 */
export const authAtom = atom(INITIAL, (get, set) => {
  onAuthed(() => set((s) => ({ ...s, phase: 'authed', error: null, loggingIn: false }))).catch(
    () => {},
  );
  onLoginCancelled(() => set((s) => ({ ...s, loggingIn: false }))).catch(() => {});
  onLoginFailed((message) =>
    set((s) => ({ ...s, loggingIn: false, error: message })),
  ).catch(() => {});

  async function refresh() {
    try {
      const ok = await isAuthed();
      set((s) => ({ ...s, phase: ok ? 'authed' : 'unauthed' }));
    } catch {
      set((s) => ({ ...s, phase: 'unauthed' }));
    }
  }
  void refresh();

  return {
    /** 打开登录 webview；成功由 "authed" 事件回填，失败置 error。 */
    async login() {
      set((s) => ({ ...s, loggingIn: true, error: null }));
      try {
        await openLogin();
      } catch (e) {
        set((s) => ({ ...s, loggingIn: false, error: String(e) }));
      }
    },
    async logout() {
      try {
        await logout();
      } finally {
        set((s) => ({ ...s, phase: 'unauthed', error: null }));
      }
    },
    refresh,
  };
});
