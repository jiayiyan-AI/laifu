// state-db.ts — bun:sqlite 只读封装 Hermes state.db 的 token usage。
//
// 只读打开 ({readonly:true})，不抢 Hermes 主进程的写锁（Hermes 是 writer，我们是 reader）。
// bun:sqlite 的 readonly 选项底层走 SQLITE_OPEN_READONLY，等价 Python
// `sqlite3.connect(f"file:{path}?mode=ro", uri=True)` 和 node:sqlite 的 file:?mode=ro URI。
//
// 每次现开现关，不持长连接——跟 Python `with SessionDB(): ...` 行为一致。
//
// 任何 SQLite 异常都吞掉 + 打日志，返回零 usage snapshot；
// 计量逻辑绝不能拖死 chat。

import { Database } from 'bun:sqlite';
import { STATE_DB_PATH, TOKEN_COLS } from './config.ts';
import type { TokenCol } from './config.ts';
import { log } from '../boot/server/logger.ts';

function openStateDb(): Database {
  // readonly:true → SQLITE_OPEN_READONLY, 不抢写锁; 等价 Python 的 ?mode=ro
  return new Database(STATE_DB_PATH, { readonly: true });
}

export type Snapshot = { model: string | null } & Record<TokenCol, number>;

export function emptySnapshot(): Snapshot {
  const base = { model: null } as Snapshot;
  for (const c of TOKEN_COLS) base[c] = 0;
  return base;
}

interface SessionRow {
  model: string | null;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  cache_read_tokens: number | string | null;
  cache_write_tokens: number | string | null;
  reasoning_tokens: number | string | null;
}

/**
 * 读 sessions 表 token 累计 + model。失败/不存在 → 全零 snapshot, 不报错。
 */
export function snapshotSession(hermesUuid: string | null | undefined): Snapshot {
  if (!hermesUuid) return emptySnapshot();
  let db: Database;
  try {
    db = openStateDb();
  } catch (e) {
    log.error({ event: 'statedb.snapshot.open.failed', err: (e as Error).message });
    return emptySnapshot();
  }
  try {
    const row = db
      .prepare<SessionRow, [string]>('SELECT * FROM sessions WHERE id = ?')
      .get(hermesUuid);
    if (!row) return emptySnapshot();
    const out: Snapshot = { model: row.model ?? null } as Snapshot;
    for (const c of TOKEN_COLS) {
      const raw = row[c as keyof SessionRow];
      out[c] = parseInt(String(raw ?? 0), 10) || 0;
    }
    return out;
  } catch (e) {
    log.error({ event: 'statedb.snapshot.failed', hermes_session_id: hermesUuid, err: (e as Error).message });
    return emptySnapshot();
  } finally {
    db.close();
  }
}

/**
 * delta = after - before, 自动包含本轮 tool loop 多轮 LLM 调用消耗。
 * model 优先 after (中途 /model 切换以最后为准, 跟 dashboard 一致)。
 */
export function usageDelta(before: Snapshot, after: Snapshot): Snapshot {
  const delta: Snapshot = { model: after.model ?? before.model ?? null } as Snapshot;
  for (const c of TOKEN_COLS) {
    const a = Number(after[c] ?? 0) || 0;
    const b = Number(before[c] ?? 0) || 0;
    delta[c] = Math.max(0, a - b);
  }
  return delta;
}
