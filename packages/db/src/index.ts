/**
 * @lingxi/db — 跨 service 共享的数据库层 (Drizzle + node-postgres 直连)。
 *
 * 暴露:
 *   - schema:        所有表/view 定义 (亦可经子路径 '@lingxi/db/schema' 导入)
 *   - createDb:      连接工厂 (config-free, 各 service 传自己的连接参数)
 *   - runMigrations: 程序化迁移
 *
 * 设计见 docs/drizzle.md。
 */
export * as schema from './schema.js';
export { createDb, type Db, type DbConfig, type DbHandle } from './client.js';
export { genId, type EntityPrefix } from './id.js';
