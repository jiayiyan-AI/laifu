# 装备能力轻量 resync(免滚 revision)设计

日期: 2026-06-23
分支: `worktree-explore+entitlement-live-resync`
范围: **仅 enable(装备/加能力)**。disable(退订)不在本期。

## 1. 背景与问题

用户在网页点「购买并装备」邮件/云盘时,**经常第一次显示"装备未完成",但实际几十秒后就成功了**。

现状链路(`apps/gateway/src/api/entitlements.ts` → `provisioning/manager.ts` → `azure.ts`):

1. `POST /api/entitlements/:feature/enable`:写 desired 入库 → `bumpTokenVersion` →(email 多一步 `ensureEmailAddress`)→ **fire-and-forget** `syncUserContainer` → 立即 200。
2. `syncUserContainer` → `reconcileContainerAppAzure` → `beginUpdateAndWait`:**滚一个新 ACA revision**(控制面 10-30s+)→ 旧容器拆掉、新容器**冷启动** → bootstrap 跑 `sync-entitlements` → 回报 observed。
3. 前端(`BuyCloudButton.tsx` / `CapabilityAction.tsx`)成功条件是 `ent.observed.includes(cap.id)`,每 2s 轮询 `/api/status`,**硬超时 30s** → 超时弹「装备未完成」。

**根因**:点亮 observed 必须走完"滚 revision + 冷启动 + bootstrap + 回报",实测 60-90s+(冷容器首次交互曾达 134s),而前端 30s 就判死。几十秒后容器真把 observed 报上来,刷新即「✓ 已装备」→ 体感"第一次失败、其实成功"。

**为什么现在非滚 revision 不可**:新的 entitlements token(`bumpTokenVersion` 后版本变了)以环境变量 `LAIFU_USER_TOKEN` 烤进容器 spec,ACA 改 env 只能滚新 revision 重投。重启是被"投递新 token"逼出来的——**技能装备本身不需要重启**(技能是 `~/.hermes/skills/<feature>` 软链,Hermes CLI 每条消息现 spawn 时重读该目录)。

### 关键发现(决定方案形态)

容器侧 `docker/hermes/server/auth.ts` 的 `requireBearer` **故意不强校 token_version**——只验:HS256 签名(GATEWAY_SECRET)+ 未过期 + user_id 匹配。

因此 **inbound(gateway→容器)方向在 token_version bump 后不会失效**;只有容器的 **outbound**(用自带 baked token 调 gateway `/api/me/*`,被 `container-token.ts` 的 `containerAuth` 校版本)会在 bump 后被拒。

## 2. 目标与非目标

**目标**
- 装备 enable 在**热容器**上 ~1-2s 完成,observed 立即翻转,消灭"假失败"。
- 冷容器统一走同一路径(请求唤醒容器,等冷启动)。
- 前端等待弹窗 block 当前界面、转圈到成功;超长超时兜底报失败。

**非目标**
- disable(退订)/降级的轻量化——保留现有 bump + 滚 revision(顺带真吊销权限),本期不动。
- 聊天慢(35s+)的优化——另案,见 memory `prod-chat-latency-diagnosis`。

## 3. 方案选型

**方案 A(采纳)——同步推送式 resync**
Gateway 把新的 desired 列表推给容器新端点 `POST /internal/resync-entitlements`,容器建好软链后**在同一响应里返回 observed**,gateway 直接落库。一次往返。
- 优点:往返最少;不依赖容器 outbound(绕开"旧 token 出站被拒");幂等。

**方案 B(未采纳)——通知 + 容器自取**
Gateway 发"去重新同步"信号,容器自己调 `/api/me/entitlements` 拉 desired 再回报 observed(把 boot 的 `runSyncEntitlements` 做成按需触发)。
- 缺点:三次往返(ping→fetch→report);且容器 outbound 要带有效 token,**强制 enable 不能 bump**,否则 fetch/report 被拒。复用度高但更脆。

## 4. 详细设计(方案 A)

### 4.1 容器侧

- `docker/hermes/server/http.ts` 新增路由 `POST /internal/resync-entitlements`,走现有 `requireBearer`(不校 version,天然能收 gateway 现签 token)。
- 把 `docker/hermes/scripts/sync-entitlements.ts` 里的**软链核心**抽成纯函数 `applyEntitlements(desired: string[]): string[]`(建/删软链,返回 observed)。
  - bootstrap 路径:拉取 desired → `applyEntitlements` → 回报 observed(原行为不变)。
  - 新端点路径:从请求体取 desired → `applyEntitlements` → **响应体返回 `{ observed, token_version }`**,不回调 gateway。
- 请求体:`{ entitlements: string[], token_version: number }`。
- 注意:`server/`(常驻 Bun server)与 `scripts/`(bootstrap 一次性脚本)共享该纯函数,实施时确认 import 路径可达(同镜像内 Bun TS)。

### 4.2 Gateway 侧

新增 `resyncEntitlements(userId)`(provisioning 层):
1. 读 desired(`dao.entitlements.listActive`)+ token_version。
2. 现签容器 token(`getContainerToken`,当前版本)。
3. `POST {containerUrl}/internal/resync-entitlements`,body 带 desired + token_version。
4. 2xx:从响应取 observed → `dao.observedState.upsert`。
5. **`dao.containerMapping.setPolicyHash(userId, azure.policyHashFor(userId))`** —— 关键。否则下次聊天 `checkAndReconcileACA` 发现 policy 哈希漂移,会再多滚一次 revision(redundant roll)。
6. **不 bump token_version、不滚 revision。**

`entitlements.ts` 的 enable 路径改为调 `resyncEntitlements`(替代 `syncUserContainer` 里的 reconcile);disable 路径原样保留 `bumpTokenVersion` + `reconcileContainerAppAzure`。

### 4.3 token 语义

能力**不在** token 里(token 仅 user_id + token_version)。加技能是纯加法,无需吊销任何现有 token → enable **不 bump**。不 bump 才能让容器自带 token 继续 outbound 有效(它的 boot-sync / 周期性调用不被 gateway 拒)。

### 4.4 前端

- 保留轮询 `/api/status` 看 observed。
- 等待弹窗保持 **modal、block 当前界面**,显示"正在装备到助理…",一直转到 `observed.includes(cap.id)` → 直接「✓ 已装备」。
- **删掉现有 30s 判死**;改为**超长超时 `EQUIP_TIMEOUT_MS = 180_000`(180s,覆盖冷启动最坏)**。到点仍未翻转 → 显示「装备失败 / 重试」。
- `enable` 的 POST 本身抛错(网络/5xx)→ 同样显示失败 + 重试。
- 文案改实:"正在装备到助理…(冷启动时助理上线约需 1 分钟)"。
- 改动文件:`BuyCloudButton.tsx`、`CapabilityAction.tsx`(两处状态机一致)。

### 4.5 错误处理与兜底

- resync 请求失败 / 容器冷启动超时:desired 已落库,**下次容器启动 bootstrap 的 `sync-entitlements` 会自然读到 desired 并回报 observed**(现成安全网)。前端继续 block 轮询,observed 翻转即成功;超 180s 才报失败让用户重试。
- 幂等:`applyEntitlements` 声明式(按 desired 建/删软链),可安全重复调用。
- 冷场景:resync 请求经 ACA HTTP ingress 自动把容器 scale 0→1 并 hold;容器起来后既可能由端点处理、也可能由 boot-sync 先收敛——两者幂等,observed 最终一致。

## 5. 测试

- **Gateway 单测**:`resyncEntitlements`(mock 容器 fetch)断言 observed 落库 + `setPolicyHash` 被调 + **不 bump token_version**;enable handler 走 resync 不走 reconcile;disable handler 仍走 reconcile + bump。
- **容器单测**:`applyEntitlements` 给定 desired 返回正确 observed + 软链落地(复用现有 `sync-entitlements` 测试套路);新端点 handler 返回 `{observed, token_version}`。
- **前端**:状态机——POST 成功后 block 轮询,observed 翻转→ready;180s 超时→failed;POST 抛错→failed。

## 6. 部署注意(红线:云上构建/部署须先获用户同意)

- 容器侧改动需**重 build Hermes 镜像**(按 ACR 流程 `cd docker/hermes && ACR_NAME=acrlingxiprod IMAGE_TAG=vX ./build-and-push.sh`,**不在本地 Mac build**)+ 滚两个用户容器到新 tag。
- gateway 改动走 `build-deploy.sh` + `az webapp deploy`。
- 顺带可在本期或单独修:`qwen3.7-max` 不在 prod 定价表导致 `pricing.miss` / `cost_cny=0`(见 memory),非本设计范围。
