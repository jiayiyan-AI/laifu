import { defineConfig } from 'drizzle-kit';

// drizzle-kit 配置 — generate / migrate / pull / studio 都读这里。
// DATABASE_URL / DATABASE_SSL 从环境取 (dev 通常用 gateway 的 .env.local 值;
// 跑 drizzle-kit 时显式带上, 例如:
//   DATABASE_URL=postgres://postgres:postgres@localhost:54422/postgres pnpm --filter @lingxi/db db:generate
export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? '',
    ssl: process.env['DATABASE_SSL'] === 'true',
  },
});
