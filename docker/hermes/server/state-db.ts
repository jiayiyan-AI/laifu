// state-db.ts — bun:sqlite 只读封装 hermes 的 state.db (历史 + token usage)
//
// hermes_state.py 在多模态 content 上加 \x00json: 前缀, JSON 序列化数组/字典;
// 读出时反过来还原。
//
// 只读打开 ({readonly:true}), 不抢 hermes 主进程的写锁 (hermes 是 writer, 我们是 reader)。
// bun:sqlite 的 readonly 选项底层走 SQLITE_OPEN_READONLY, 等价 Python
// `sqlite3.connect(f"file:{path}?mode=ro", uri=True)` 和 node:sqlite 的 file:?mode=ro URI。
//
// 每次现开现关, 不持长连接 — 跟 Python `with SessionDB(): ...` 行为一致。
//
// 任何 SQLite 异常都吞掉 + 打日志, 返回 fallback 值 (空 messages / 零 snapshot)。
// 计量逻辑绝不能拖死 chat。

import { Database } from 'bun:sqlite';
import { STATE_DB_PATH, TOKEN_COLS } from './config.ts';
import type { TokenCol } from './config.ts';
import { log } from './logger.ts';

const CONTENT_JSON_PREFIX = '\x00json:';

export type DecodedContent = unknown;

function decodeContent(c: unknown): DecodedContent {
  if (typeof c === 'string' && c.startsWith(CONTENT_JSON_PREFIX)) {
    try {
      return JSON.parse(c.slice(CONTENT_JSON_PREFIX.length));
    } catch {
      return c;
    }
  }
  return c;
}

function openStateDb(): Database {
  // readonly:true → SQLITE_OPEN_READONLY, 不抢写锁; 等价 Python 的 ?mode=ro
  return new Database(STATE_DB_PATH, { readonly: true });
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: DecodedContent;
  ts: number | string | null;
}

interface MessageRow {
  role: string;
  content: string | null;
  tool_calls: string | null;
  timestamp: number | string | null;
}

/**
 * 按 hermes session uuid 拉激活消息列表 (跳过 rewind 软删 + 跳过 tool 调用 + 空 content)。
 * 返回形如 [{role, content, ts}], content 自动 decode 多模态。
 */
export function loadMessagesByUuid(uuid: string | null | undefined): HistoryMessage[] {
  if (!uuid) return [];

  let db: Database;
  try {
    db = openStateDb();
  } catch (e) {
    log.error({ event: 'statedb.open.failed', err: (e as Error).message });
    return [];
  }

  try {
    // 默认 active=1 跳过软删 (rewind), 跟 hermes_state.get_messages(include_inactive=False) 一致
    const rows = db
      .prepare<MessageRow, [string]>(
        `SELECT role, content, tool_calls, timestamp
         FROM messages WHERE session_id = ? AND active = 1 ORDER BY id`,
      )
      .all(uuid);

    const out: HistoryMessage[] = [];
    for (const r of rows) {
      // 跳过 tool 调用 (assistant 带 tool_calls 但 content 是占位)、tool 返回、空 content
      if (r.role !== 'user' && r.role !== 'assistant') continue;
      if (r.tool_calls) continue;
      if (!r.content) continue;
      out.push({ role: r.role, content: decodeContent(r.content), ts: r.timestamp });
    }
    return out;
  } finally {
    db.close();
  }
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
