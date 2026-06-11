/**
 * Seed 脚本 — 灌初始/测试数据。
 *
 * 用法:
 *   cd packages/db
 *   DATABASE_URL=postgres://postgres:postgres@localhost:54422/postgres pnpm db:seed
 *
 * 幂等设计: 用 onConflictDoNothing()，重复跑不报错不重复插。
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

const url = process.env['DATABASE_URL'];
if (!url) { console.error('DATABASE_URL missing'); process.exit(1); }

const pool = new pg.Pool({
  connectionString: url,
  ssl: process.env['DATABASE_SSL'] === 'true' ? { rejectUnauthorized: false } : undefined,
  max: 1,
});
const db = drizzle(pool, { schema });

// ── 补充对象（drizzle-kit push/generate 不能自动生成的）─────────
// pricing_current view + lower(email) 部分唯一索引
// 幂等: IF NOT EXISTS / OR REPLACE
await pool.query(`
  CREATE OR REPLACE VIEW pricing_current AS
    SELECT DISTINCT ON (provider, model) *
    FROM pricing
    ORDER BY provider, model, effective_at DESC;
`);
await pool.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique
    ON users (lower(email)) WHERE email IS NOT NULL;
`);
console.log('[seed] views & indexes ✓');

// ── pricing 种子（模型单价）──────────────────────────────────────────
await db.insert(schema.pricing).values([
  { provider: 'alibaba',   model: 'qwen3-coder-plus', price_in: '4.0',  price_out: '16.0',  price_cached: '1.0', effective_at: new Date('2025-06-01') },
  { provider: 'alibaba',   model: 'qwen3.7-max',      price_in: '12.0', price_out: '36.0',  price_cached: '2.4', effective_at: new Date('2025-06-01') },
  { provider: 'anthropic', model: 'claude-sonnet-4',  price_in: '22.0', price_out: '110.0', price_cached: '5.5', effective_at: new Date('2025-06-01') },
]).onConflictDoNothing();

console.log('[seed] pricing ✓');

// ── 未来加更多 seed 在这里 ──────────────────────────────────────────
// 示例: 测试用户
// await db.insert(schema.users).values({
//   provider: 'dev',
//   external_id: 'seed-user-1',
//   email: 'dev@localhost',
//   nickname: '开发测试',
// }).onConflictDoNothing();

await pool.end();
console.log('[seed] done');
