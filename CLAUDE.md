# 灵犀 (lingxi / laifu)

托管版 Hermes Agent 平台：用户注册即拿到独立 Hermes 实例，通过网页或微信对话。

## 仓库结构

pnpm monorepo，Node 22，TypeScript。

```
apps/
  gateway/   Express，唯一后端进程。/api/* + OAuth + iLink polling + 每用户 ACA 调度
  web/       Vite + React 前端，prod 由 gateway 同进程 express.static 托管
packages/
  db/        @lingxi/db — 共享数据库层 (Drizzle schema + client + 迁移)
  shared/    跨端类型 / 契约 / 工具，gateway+web 共用
docker/hermes/  Hermes 容器镜像 (Bun + TypeScript `server/index.ts` 包 Hermes CLI，挂 /home/hermes)
infra/bicep/    Azure 长期资源声明（RG/ACR/Storage/CAE/KV/ASP/AppService + 6 role）
scripts/build-deploy.sh     vite lib mode 把 gateway 打成单文件 + 扁平 node_modules
```

## 关键阅读顺序

动代码前按需读：

- `docs/architecture.md` — 总图、调度方案 B (Job 队列) 与方案 A 的取舍
- `docs/environments.md` — dev/prod 差异、env 同步三守则、`PROVISIONER` 分支
- `docs/deployment.md` — 4 类资产（基建 / Hermes 镜像 / Gateway+Web / 每用户实例）的变化频率与工具
- `docs/deployment-azure-first-run.md` — Supabase key 体系 / Kudu / HNS 一次性 flag / build 顺序等无法代码化的坑
- `docs/known-issues.md` — **#1 ACA 容器必须并发 health**；**#6 SQLite on SMB 锁失败 — 已修复 (切 NFS), 保留踩坑记录**；**#9 App Service KV reference cache 不自动重 resolve**；**#10 ACA `no_new_privs` 禁 sudo, subPath 子目录 owner 必须 initContainer 修**
- `docs/nfs.md` — Hermes volume SMB → NFS 4.1 迁移方案与执行记录 (已落地)
- `docs/auth-setup.md` — Google OAuth + iLink 微信绑定

## 架构要点（避免重复推导）

- 当前调度**实际走方案 A**：每用户独立 ACA + gateway 同步 `POST /chat`（`apps/gateway/src/api/chat.ts`）。`docs/architecture.md` 里"采纳方案 B"是规划文档，代码还没切。已知会被 ACA Ingress 4 分钟超时咬到（`known-issues.md#2`），目前靠 DashScope qwen-plus 回复快暂时压住，真长任务来了得切方案 B。
- **每用户独立 ACA + 共享 NFS share + subPath 隔离**: 所有用户共用一个 100 GiB NFS share (`hermes-shared`), 每人挂自己的子目录 `user-<8位hex>/` 到 `/home/hermes` (容器内看不到兄弟用户)。存储成本固定 ~$16/月不随用户数线性涨。每用户开通时, gateway provisioning 会启一个 busybox initContainer 以 root 跑 chown 修子目录 owner (ACA `no_new_privs` 禁 sudo, 主容器自己改不了), 然后才起 hermes 主容器。详见 `docs/nfs.md` §十 + `docs/known-issues.md` #10。pip/npm 全局包目录已在 Dockerfile 重定向到 home 下, 包持久化。
- Gateway 跑 App Service B1，常驻维持 iLink long-polling。**不要**改成 Container Apps / Workers。
- 前后端**同进程同域**（prod）：`express.static` 托管 `apps/web/dist`，无 CORS，OAuth redirect 同源。dev 才走 vite :3000 → gateway :9000 代理。
- `ContainerMappingCache` 是进程内 Map 无 TTL — 手动改 supabase `container_mapping` 后必须重启 App Service 才生效。

## env 与 dev/prod 守则（强约束）

1. **不写 `NODE_ENV === 'production'` 分支**。差异性行为靠 env 值切，不靠代码分支。
2. 新 env **同步出现在三处**：`apps/gateway/.env.example` + `apps/gateway/src/config.ts` + `infra/bicep/main.bicep` appSettings（敏感值走 `@Microsoft.KeyVault(...)`）。漏一处必漂移。
3. `PROVISIONER=local` 走 `provisioning/local.ts` 假进度 + 共享本地 docker `:8080`；`PROVISIONER=azure` 走 `azure.ts` 真建 ACA + File share + binding (~22s)。业务代码不分支。
4. dev 的 Google OAuth / LLM 都用真 cloud dev 项目，**唯独 Hermes 必须本地 docker**（ACA 太贵太慢）。本地 PG 用 `./scripts/dev-db.sh`（轻量单容器）。

## 常用命令

```bash
pnpm dev              # 同时起 hermes (docker) + gateway :9000 + web :3000
pnpm dev:check        # 自检 prereq (docker / pg / .env.local)
pnpm build            # 全工程 build
pnpm --filter @lingxi/shared build   # 可选；build-deploy.sh 现在会自动先 build shared
./scripts/build-deploy.sh            # 产出 app-service-deploy/（gateway 单文件 + web-dist + 扁平 node_modules）
```

部署到 Azure：

注意，当前云上环境只有 dev，没有 prod，除非我特别说明，否则一般我们云上都特指 dev 环境。

```bash
cd infra/bicep && ./deploy.sh dev    # 或 prod
# 改完应用代码：
./scripts/build-deploy.sh
cd app-service-deploy && zip -rq ../deploy.zip . -x '*.map' && cd ..
az webapp deploy -g rg-lingxi-${ENV} -n app-lingxi-${ENV}-gateway --src-path deploy.zip --type zip
```

Hermes 镜像（**不要本地 build**，Mac arm64 与 ACA amd64 不兼容）：

```bash
cd docker/hermes && ACR_NAME=acrlingxi${ENV} IMAGE_TAG=vX ./build-and-push.sh
```

## 红线

- 如果没有我的明示，做任何云上的部署，构建动作前，必须先征求我的同意
- 不要把 `/home/hermes` 拆成多个挂载点 — Agent 用任意 CLI，逐个枚举挂不完。整盘挂是设计。
- 不要给 ACA Environment 配 VNet / Private Endpoint，会产生 ~€2/天基础设施费。默认配置无此费用。
- 不要在 hermes `server/*.ts` 里写阻塞 event loop 的同步重计算 — 单 event loop 模型, 长 CPU 任务会拖死 /health probe, 5 次失败被强杀。
- App Service `Always On` 必须开，防 polling 进程被空闲回收。
- 改 storage account 不能事后加 `isHnsEnabled`，是创建时一次性 flag，必须删 RG + purge KV 重建（dev 才能这么干）。
- gateway system identity 必须同时拿 `Storage Account Contributor`（建 File Share）**和** `Storage Blob Data Owner`（签 User Delegation Key，云盘必需）。

## 语言

代码注释 / 文档 / 对话默认中文。
