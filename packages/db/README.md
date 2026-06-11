# @lingxi/db

跨 service 共享的数据库层。基于 [Drizzle ORM](https://orm.drizzle.team) + `node-postgres` 直连 Postgres wire protocol。

## 为什么存在

- **schema.ts 是唯一事实标准**——所有表、列、索引的定义集中在这里，类型自动推导到业务代码。
- **与具体库解耦**——本地 supabase PG、云上 Supabase 真实库、将来的 Azure PG，切换只改 `DATABASE_URL`。
- **共享包不依赖任何 service 的 config**——暴露工厂 `createDb(opts)`，各 service 传自己的连接参数。

## 目录结构

```
packages/db/
├── src/
│   ├── schema.ts       所有表/view 定义（类型权威源）
│   ├── client.ts       createDb(opts) 连接工厂
│   ├── migrate.ts      runMigrations(opts) 程序化迁移
│   ├── seed.ts         种子数据 + 补充对象（view、表达式索引）
│   └── index.ts        barrel 导出
├── drizzle/            迁移 SQL（drizzle-kit generate 产出）
├── drizzle.config.ts   drizzle-kit 配置
├── migrate-deploy.mjs  部署单元独立迁移入口（零内部依赖）
└── package.json
```

---

## drizzle-kit 命令详解

### 核心概念：两条路径，互不干扰

```
┌──────────────────────────────────────────────────┐
│            schema.ts（你写的，唯一真相）             │
└─────────────┬───────────────────┬────────────────┘
              │                   │
        ┌─────▼─────┐      ┌─────▼──────┐
        │   push    │      │  generate  │
        │  (直连库)  │      │  (生成SQL)  │
        └─────┬─────┘      └─────┬──────┘
              │                   │
              ▼                   ▼
          目标数据库          drizzle/*.sql
          (立刻改表)          (迁移文件)
                                  │
                            ┌─────▼─────┐
                            │  migrate  │
                            │  (执行SQL) │
                            └─────┬─────┘
                                  │
                                  ▼
                              目标数据库
```

**这是两条独立的路径，不是一个流水线的上下游。**

---

### `push` — 直接同步，不留痕迹

```bash
pnpm db:push
```

| | |
|---|---|
| **做什么** | 拿 schema.ts diff 目标数据库的**实际状态**，算出 ALTER/CREATE 语句，直接执行 |
| **不做什么** | 不生成迁移文件、不读 `drizzle/` 目录、不写 `__drizzle_migrations` 表 |
| **类比** | 像 `rsync` ——"让目标跟源一样"，不管过程，不留记录 |
| **适合** | 本地开发、快速迭代、一个人折腾 |

---

### `generate` — 只生成 SQL 文件，不碰库

```bash
pnpm db:generate --name add_user_phone
```

| | |
|---|---|
| **做什么** | 拿 schema.ts diff `drizzle/meta/` 里的**上次快照**，算出差异，写入新文件如 `drizzle/0001_add_user_phone.sql` |
| **不做什么** | 不连数据库、不执行任何 SQL |
| **类比** | 像 `git diff > patch` ——只产出补丁文件 |
| **适合** | 准备云上部署、code review、多人协作 |

---

### `migrate` — 按顺序执行迁移文件

```bash
pnpm db:migrate
```

| | |
|---|---|
| **做什么** | 读 `drizzle/` 里所有 SQL 文件，跟数据库 `__drizzle_migrations` 表对比，按顺序执行未跑过的 |
| **不做什么** | 不看 schema.ts、不做 diff |
| **类比** | 像 flyway ——按版本号跑未执行的 SQL |
| **适合** | 云上部署、CI/CD、多环境同步 |

---

### 三者关系速查

| | push | generate | migrate |
|---|---|---|---|
| 读 schema.ts | ✅ | ✅ | ❌ |
| 连数据库 | ✅ | ❌ | ✅ |
| 读/写 `drizzle/` 迁移文件 | ❌ | ✅ 写 | ✅ 读 |
| 读/写 `__drizzle_migrations` 表 | ❌ | ❌ | ✅ |
| 留版本记录 | ❌ | ✅ | ✅ |

---

### push 会不会破坏 migration 文件的连贯性？

**不会。** push 根本不看也不碰 `drizzle/` 目录。

```
时间线示例：
  1. schema.ts 有 users(id, name, email)
  2. generate → drizzle/0000_baseline.sql
  3. 你改 schema.ts 加了 phone 列
  4. 本地 push → 本地库立刻有 phone 列 ✓（不影响 drizzle/ 目录）
  5. generate → drizzle/0001_add_phone.sql ✓（对比的是 meta 快照，不是数据库）
```

步骤 4 的 push 不影响步骤 5 的 generate，因为 generate 对比的是 schema.ts vs `drizzle/meta/` 里的快照（上次 generate 的状态），跟目标数据库无关。

---

## 日常工作流

所有命令在 `packages/db/` 下执行，需带 `DATABASE_URL` 环境变量。

```bash
# ── 本地开发（最常用）──────────────────────────────────────
# schema.ts 改完后，同步到本地库（幂等，增量 diff，瞬间完成）
DATABASE_URL=postgres://postgres:postgres@localhost:54422/postgres pnpm db:push

# 灌种子数据（pricing 单价、view、表达式索引）
DATABASE_URL=postgres://postgres:postgres@localhost:54422/postgres pnpm db:seed

# ── 云上部署 ───────────────────────────────────────────────
# 生成版本化迁移 SQL（提交到 git，可 review）
DATABASE_URL=<云上连接串> pnpm db:generate --name add_xxx

# 应用迁移到云上库
DATABASE_URL=<云上连接串> pnpm db:migrate

# ── 辅助 ───────────────────────────────────────────────────
# 可视化浏览库结构
DATABASE_URL=... pnpm db:studio
```

### 典型日常流程

```bash
# 1. 改 schema
vim src/schema.ts

# 2. 本地立刻同步
DATABASE_URL=postgres://postgres:postgres@localhost:54422/postgres pnpm db:push

# 3. 开发调试完毕，准备上线
DATABASE_URL=... pnpm db:generate --name add_xxx
git add drizzle/
git commit -m "db: add xxx"

# 4. 部署后，云上执行迁移
DATABASE_URL=... pnpm db:migrate
```

---

## 如何改表

1. 编辑 `src/schema.ts`（加列、加表、改类型…）
2. 本地：`pnpm db:push` 立刻生效
3. 云上：`pnpm db:generate --name xxx` → `pnpm db:migrate`
4. 如果加了新种子数据，更新 `src/seed.ts`

示例——给 users 加一列：

```ts
// src/schema.ts
export const users = pgTable('users', {
  // ...existing
  phone: text('phone'),  // ← 新增
});
```

```bash
DATABASE_URL=... pnpm db:push                            # 本地立刻生效
DATABASE_URL=... pnpm db:generate --name add_user_phone  # 给云上用
```

---

## 在 service 中使用

```ts
// apps/gateway/src/db/client.ts（薄封装单例）
import { createDb, type Db } from '@lingxi/db';
import { config } from '../config.js';

let handle = createDb({ url: config.db.url, ssl: config.db.ssl, poolMax: config.db.poolMax });
export const getDb = () => handle.db;
```

```ts
// 业务代码
import { getDb } from '../db/client.js';
import { schema } from '@lingxi/db';
import { eq, desc } from 'drizzle-orm';

const threads = await getDb()
  .select()
  .from(schema.threads)
  .where(eq(schema.threads.user_id, userId))
  .orderBy(desc(schema.threads.updated_at));
```

---

## seed 的设计

`src/seed.ts` 负责：

1. **补充对象**——`pricing_current` view、`lower(email)` 表达式索引（drizzle-kit 无法从 schema.ts 生成这些）
2. **种子数据**——pricing 模型单价等初始行

全部幂等（`CREATE OR REPLACE` / `IF NOT EXISTS` / `onConflictDoNothing`），跑多少次结果一样。

---

## 部署

`scripts/build-deploy.sh` 会把 `drizzle/` + `migrate-deploy.mjs` 拷进部署单元。
部署后执行迁移：

```bash
DATABASE_URL=... DATABASE_SSL=true node migrate-deploy.mjs
```

`migrate-deploy.mjs` 零内部依赖，只用部署 `node_modules` 里的 `pg` + `drizzle-orm` + 环境变量。

---

## 与本地 PG 容器的关系

`./scripts/dev-db.sh start` 起一个轻量 PG 容器（`postgres:17-alpine`，端口 54422）。
首次启动后需 `pnpm db:push` + `pnpm db:seed` 建表和灌数据。

> `infra/supabase/` 已删除，不再依赖 supabase CLI。
