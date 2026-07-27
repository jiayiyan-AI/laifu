// 清理过期的微信附件缓存 (image/document/audio/video, 默认 7 天 TTL)。
//
// 替代旧 entrypoint.sh 里的两行 find sweep: ACA scale-to-zero 是天然 cron, 几乎每天
// 冷启动一次, 启动时扫一遍即可; server/inbox.ts 落盘后再 best-effort 扫一次覆盖长时在线
// 用户 (双触发, 见 weichat-file-impl.md §3.2)。
//
// 递归扫整个 inbox/ 子树: 删 mtime 超 TTL 的文件 + 清掉随之变空的目录。全程吞错,
// 任一节点失败只跳过该节点, 不中断整体 sweep, 更不阻塞 bootstrap。
import { readdir, rm, rmdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { log } from './lib.ts';
import { HERMES_HOME_DIR } from '../../home.ts';

// 只扫 Gateway-owned 的 inbox/ 子树，绝不触碰 Hermes 或 Pi 的私有 state/cache。
const INBOX_ROOT_DIR = path.join(HERMES_HOME_DIR, 'inbox');
const LEGACY_INBOX_ROOT_DIR = path.join(HERMES_HOME_DIR, '.hermes', 'cache', 'laifu-inbox');
const TTL_DAYS = Number(process.env.INBOX_CACHE_TTL_DAYS) || 7;

interface SweepResult {
  files: number;     // 删掉的文件数
  dirs: number;      // 删掉的空目录数
  remaining: number; // 本层留存 (未过期文件 / 删不掉的节点) → 非 0 则父目录不删
}

/** 递归清一棵目录树。目录不存在视为无事可做。 */
async function sweepTree(dir: string, cutoffMs: number): Promise<SweepResult> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { files: 0, dirs: 0, remaining: 0 };
  }

  let files = 0;
  let dirs = 0;
  let remaining = 0;

  for (const name of names) {
    const full = path.join(dir, name);
    let st;
    try {
      st = await stat(full);
    } catch {
      continue; // 并发被清掉, 忽略
    }

    if (st.isDirectory()) {
      const r = await sweepTree(full, cutoffMs);
      files += r.files;
      dirs += r.dirs;
      if (r.remaining === 0) {
        try {
          await rmdir(full);
          dirs++;
        } catch {
          remaining++;
        }
      } else {
        remaining++;
      }
    } else if (st.mtimeMs < cutoffMs) {
      try {
        await unlink(full);
        files++;
      } catch {
        remaining++;
      }
    } else {
      remaining++;
    }
  }

  return { files, dirs, remaining };
}

/** 可单测入口: 清 dir 下 mtime 超 ttlMs 的文件 + 随之变空的目录, 返回删除计数。 */
export async function sweepCacheTree(dir: string, ttlMs: number): Promise<{ files: number; dirs: number }> {
  const { files, dirs } = await sweepTree(dir, Date.now() - ttlMs);
  return { files, dirs };
}

// 迁移期清理：2026-08-26 后删除本函数与调用。旧路径已停止写入，启动时幂等移除遗留附件。
async function removeLegacyInboxCache(): Promise<void> {
  await rm(LEGACY_INBOX_ROOT_DIR, { recursive: true, force: true }).catch(() => {});
}

/** bootstrap 调用入口: 清理遗留 Hermes 缓存后，扫 ~/inbox 的过期附件与空目录。 */
export async function sweepCache(): Promise<void> {
  await removeLegacyInboxCache();
  const { files, dirs } = await sweepCacheTree(INBOX_ROOT_DIR, TTL_DAYS * 86_400_000);
  if (files > 0 || dirs > 0) {
    log(`cache sweep: removed ${files} file(s), ${dirs} empty dir(s)`);
  }
}
