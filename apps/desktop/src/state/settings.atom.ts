import { atom } from '@lingxi/atom';
import { getSyncDir, pickSyncDir, setSyncDir } from '@/lib/ipc';

export interface SettingsData {
  syncDir: string | null;
  saving: boolean;
  error: string | null;
}

const INITIAL: SettingsData = { syncDir: null, saving: false, error: null };

/**
 * 设置 atom：本地同步目录选择与持久化。目录经原生对话框选取（pick_sync_dir），
 * 选定后立即 set_sync_dir 让 Rust 启 watcher+poller。
 */
export const settingsAtom = atom(INITIAL, (get, set) => {
  // 启动回显：从 Rust 读上次持久化的同步目录（重启后仍显示已选路径，而非"未选择"）。
  getSyncDir()
    .then((dir) => {
      if (dir) set((s) => ({ ...s, syncDir: dir }));
    })
    .catch(() => {});

  return {
    /** 弹原生目录对话框，选中即保存并启同步。 */
    async choose() {
      set((s) => ({ ...s, error: null }));
      let dir: string | null;
      try {
        dir = await pickSyncDir();
      } catch (e) {
        set((s) => ({ ...s, error: String(e) }));
        return;
      }
      if (dir === null) return; // 用户取消
      await save(dir);
    },
  };

  async function save(dir: string) {
    set((s) => ({ ...s, saving: true, error: null }));
    try {
      await setSyncDir(dir);
      set((s) => ({ ...s, syncDir: dir, saving: false }));
    } catch (e) {
      set((s) => ({ ...s, saving: false, error: String(e) }));
    }
  }
});
