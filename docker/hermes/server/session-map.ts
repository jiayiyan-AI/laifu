// session-map.ts — 持久化 {gateway_session_name → hermes_session_uuid} 映射
//
// Hermes CLI 的 --resume 必须给已有 UUID。本层维护 gateway 视角 name 到 hermes 内
// UUID 的映射, 持久化在 ~/.hermes/_gateway_session_map.json (落用户 volume,
// 容器重启不丢)。
//
// 并发安全: 一个 Promise 串行队列 (mapLock), 同时刻最多一个 load+save 在跑,
// 语义等价 Python `threading.Lock` + with 块。

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SESSION_MAP_FILE } from './config.ts';

type SessionMap = Record<string, string>;

let mapLock: Promise<unknown> = Promise.resolve();

function withMapLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = mapLock.then(fn, fn);
  // 一次失败不阻塞后续: 把 chain 恢复成 resolved
  mapLock = next.catch(() => {});
  return next;
}

async function loadMap(): Promise<SessionMap> {
  try {
    return JSON.parse(await readFile(SESSION_MAP_FILE, 'utf8')) as SessionMap;
  } catch {
    return {};
  }
}

async function saveMap(m: SessionMap): Promise<void> {
  await mkdir(dirname(SESSION_MAP_FILE), { recursive: true });
  const tmp = `${SESSION_MAP_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(m, null, 2));
  await rename(tmp, SESSION_MAP_FILE);
}

export function getHermesId(name: string): Promise<string | null> {
  return withMapLock(async () => (await loadMap())[name] ?? null);
}

export function putHermesId(name: string, hermesId: string): Promise<void> {
  return withMapLock(async () => {
    const m = await loadMap();
    m[name] = hermesId;
    await saveMap(m);
  });
}

// 删除一个映射条目; 不存在时静默通过 (idempotent)。
// 调用方: HTTP DELETE /session 在 `hermes sessions delete` 成功后调一次, 把
// {gateway_name → hermes_uuid} 这条孤记录摘掉, 避免 list/history 翻出已死的 UUID。
export function delHermesId(name: string): Promise<void> {
  return withMapLock(async () => {
    const m = await loadMap();
    if (!(name in m)) return;
    delete m[name];
    await saveMap(m);
  });
}
