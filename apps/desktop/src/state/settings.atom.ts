import { atom } from '@lingxi/atom';
import {
  configureEmptySyncDir,
  getSyncDir,
  pickEmptySyncDir,
  pickSyncMoveDestination,
  relocateSyncDir,
} from '@/lib/ipc';

export interface SettingsData {
  syncDir: string | null;
  saving: boolean;
  error: string | null;
}

const INITIAL: SettingsData = { syncDir: null, saving: false, error: null };

/**
 * 设置 atom：同步目录只能初次配置为空目录、改用新的空目录，或同卷物理移动。
 * Rust 命令是最终安全边界；此处只管理原生选择器、保存状态与错误展示。
 */
export const settingsAtom = atom(INITIAL, (_get, set) => {
  // 启动回显：从 Rust 读上次持久化的同步目录（重启后仍显示已选路径，而非"未选择"）。
  getSyncDir()
    .then((dir) => {
      if (dir) set((s) => ({ ...s, syncDir: dir }));
    })
    .catch(() => {});

  return {
    /** 选择一个严格空目录候选；取消或选择器失败返回 null。 */
    async pickEmptyDirectory() {
      return pickDirectory(pickEmptySyncDir);
    },

    /** 选择同步目录物理移动的目标上级目录；取消或选择器失败返回 null。 */
    async pickMoveDestination() {
      return pickDirectory(pickSyncMoveDestination);
    },

    /** 改用 Rust 再次校验过的空目录。 */
    async configureEmptyDirectory(dir: string) {
      return save(async () => {
        await configureEmptySyncDir(dir);
        return dir;
      });
    },

    /** 将当前目录移动到目标上级目录；完成后从 Rust 回读最终路径。 */
    async relocateDirectory(destinationParent: string) {
      return save(async () => {
        await relocateSyncDir(destinationParent);
        const dir = await getSyncDir();
        if (!dir) throw new Error('目录已移动，但无法读取新同步目录');
        return dir;
      });
    },
  };

  async function pickDirectory(pick: () => Promise<string | null>) {
    set((s) => ({ ...s, error: null }));
    try {
      return await pick();
    } catch (e) {
      set((s) => ({ ...s, error: String(e) }));
      return null;
    }
  }

  async function save(action: () => Promise<string>) {
    set((s) => ({ ...s, saving: true, error: null }));
    try {
      const syncDir = await action();
      set((s) => ({ ...s, syncDir, saving: false }));
      return true;
    } catch (e) {
      set((s) => ({ ...s, saving: false, error: String(e) }));
      return false;
    }
  }
});
