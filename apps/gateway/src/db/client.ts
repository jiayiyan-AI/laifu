/**
 * gateway 侧的 Db 单例封装 — 真正的连接工厂在共享包 @lingxi/db。
 *
 * 这里只负责: 把 gateway 自己的 config.db 喂给 createDb, 维护进程内单例。
 * 业务/DAO 代码统一 import { getDb } 这里, 不直接碰 pg/drizzle。
 */
import { createDb, type Db, type DbHandle } from '@lingxi/db';
import { config } from '../config.js';

let _handle: DbHandle | null = null;

export const getDb = (): Db => {
  if (!_handle) {
    _handle = createDb({
      url: config.db.url,
      ssl: config.db.ssl,
      poolMax: config.db.poolMax,
    });
  }
  return _handle.db;
};

/** 单元测试 / 优雅退出用：关连接池、清单例。 */
export const closeDb = async (): Promise<void> => {
  await _handle?.close();
  _handle = null;
};

export type { Db };
