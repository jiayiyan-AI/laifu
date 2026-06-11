/**
 * Drizzle 连接工厂 — 与具体 service 的 config 解耦。
 *
 * 共享包不依赖任何 service 的配置；调用方 (gateway / 未来其他 service) 各自把连接参数
 * 传进来。每个 service 自己维护单例 (见 apps/gateway/src/db/client.ts 的薄封装)。
 */
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

export interface DbConfig {
  /** postgres://user:pwd@host:5432/db */
  url: string;
  /** 云库强制 TLS (Supabase / Azure PG 都是); 本地 :54422 不需。SSL 走参数对象而非 URL ?sslmode= (pg URL ssl 有坑)。 */
  ssl?: boolean;
  /** 连接池上限 (App Service B1 单进程 10~20 足够)。默认 10。 */
  poolMax?: number;
}

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  /** 优雅退出 / 单测用。 */
  close: () => Promise<void>;
}

export const createDb = (cfg: DbConfig): DbHandle => {
  if (!cfg.url) throw new Error('createDb: url missing');
  const pool = new pg.Pool({
    connectionString: cfg.url,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
    max: cfg.poolMax ?? 10,
    idleTimeoutMillis: 30_000,
  });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
};
