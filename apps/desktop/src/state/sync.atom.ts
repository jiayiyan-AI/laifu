import { atom } from '@lingxi/atom';
import { getSyncStatus, type SyncStatus } from '@/lib/ipc';

const INITIAL: SyncStatus = { phase: 'idle', message: null };

/**
 * 同步状态 atom。异步初始化：首次订阅时每 2s 轮询 Rust get_sync_status。
 * 轮询器进程级只启一次（atom 单例缓存），组件多处订阅共享同一份状态。
 */
export const syncAtom = atom(INITIAL, (get, set) => {
  async function tick() {
    try {
      set(await getSyncStatus());
    } catch {
      // Rust 未就绪时忽略，下轮再拉。
    }
  }
  void tick();
  setInterval(() => void tick(), 2000);

  return { refresh: tick };
});
