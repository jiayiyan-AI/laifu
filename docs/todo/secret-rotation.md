# Secret 轮换设计 — Dual-Secret 无中断方案

> 目标:任何时刻能换掉 `GATEWAY_SECRET` 而**不中断**用户 chat / web 登录 / 容器 callback。
> 适用对象:目前的 `gateway-secret` (HS256 JWT 签发密钥)。日后 `session-secret` 等同类对称密钥可复用同套机制。

---

## 1. 问题

`gateway-secret` 是 HS256 JWT 的对称密钥,**Gateway** 和 **每个用户的 ACA 容器** 都必须持有同一把才能互验。当前持有方:

| 持有方 | 来源 | 是否本期之后才有 |
|---|---|---|
| Gateway (App Service) | `GATEWAY_SECRET` env, bicep KV reference → `kv-lingxi-dev/secrets/gateway-secret` | 现状 |
| 用户 ACA 容器 | `GATEWAY_SECRET` env, ACA secrets[] KV reference 引用同一个 KV secret | **已注入** (gateway 侧 `buildSpec`, dynamic-update-aca 试点); Task 4 仅补容器侧 verify 消费 |

**直接换 KV 值的结果(已论证)**:
1. App Service 不自动 re-resolve KV reference (`known-issues.md #9`)。
2. 即使触发 `KV_REFRESH_TRIGGER` 让 Gateway 拉新值,**所有容器手里的旧 token 立刻被 verify 拒**(签名不匹配,`TokenInvalidError`)。
3. 容器侧 `docker/hermes/scripts/refresh-token.ts` **救不了**——它调 `/api/auth/refresh-token` 时也要先验签,401 后日志一行 `keeping old`,**永远续不上**。
4. 全部 chat callback 链路断裂,业务进入"用户消息发出去无反应"状态,直到运维手动对每个 ACA 重签 token + 重启。

**用户体验上,这等于一次跨小时级的服务中断**。

---

## 2. 设计:Dual-Secret 容忍期

核心:**签发(sign)恒用 primary;验证(verify)按 `[primary, previous]` 顺序尝试,任一通过即放行。**

```
Gateway 进程持有 (env):
  GATEWAY_SECRET            = S_new   ← 用来 sign
  GATEWAY_SECRET_PREVIOUS   = S_old   ← 仅 verify fallback, 可空

ACA 容器持有 (env):
  GATEWAY_SECRET            = S_new
  GATEWAY_SECRET_PREVIOUS   = S_old   ← 同上, 可空

sign(payload):
  → HMAC-SHA256(payload, S_new)

verify(token):
  try   HMAC-SHA256-verify(token, S_new)    ; pass
  catch HMAC-SHA256-verify(token, S_old?)   ; pass
  catch throw TokenInvalidError
```

任何时刻只要 `previous` 存在,**旧 secret 签的 token 也能被验过**。轮换变成"安全的中间状态":

```
[A]  稳态: primary=S1, previous=null
       │
       │  操作 1: KV 加 gateway-secret-previous=S1; 写新 gateway-secret=S2
       │  操作 2: Gateway + ACA 全部拉新 env (触发 KV_REFRESH_TRIGGER + 滚动)
       ▼
[B]  共存期: primary=S2, previous=S1
       此时 sign 用 S2; 容器手里的旧 token (S1 签) 仍能 verify 过
       新签出去的 token 用 S2; 跟容器手里的旧 token 自然交替
       │
       │  等待:  90 天 (JWT 寿命) — 所有旧 token 自然过期被 refresh 换新
       │  或主动: 跑全量重签脚本, 让所有容器立刻换上 S2 签的新 token
       ▼
[A'] 稳态: primary=S2, previous=null
       KV 删 gateway-secret-previous; Gateway + ACA 再拉一次新 env
```

**整个过程 verify 永远能过,业务零感知**。

---

## 3. 实现细节

### 3.1 Gateway 侧

**`apps/gateway/src/config.ts`** 加一项:

```ts
auth: {
  gatewaySecret: process.env['GATEWAY_SECRET'] ?? 'dev-only-gateway-secret',
  gatewaySecretPrevious: process.env['GATEWAY_SECRET_PREVIOUS'] || null,  // 空字符串也当 null
}
```

**`apps/gateway/src/lib/gateway-token.ts`** `verifyLaifuUserToken` 改签名:

```ts
export interface VerifyInput {
  expectedTokenVersion: number;
  secret: string;
  secretPrevious?: string | null;   // ← 新增, fallback
  allowExpiredWithinDays?: number;
}

export function verifyLaifuUserToken(token: string, input: VerifyInput): DecodedPayload {
  let raw: JwtPayload;
  try {
    raw = jwt.verify(token, input.secret, { algorithms: [ALGORITHM], ignoreExpiration: true }) as JwtPayload;
  } catch (err) {
    if (input.secretPrevious) {
      try {
        raw = jwt.verify(token, input.secretPrevious, { algorithms: [ALGORITHM], ignoreExpiration: true }) as JwtPayload;
      } catch {
        throw new TokenInvalidError(err instanceof Error ? err.message : 'invalid token');
      }
    } else {
      throw new TokenInvalidError(err instanceof Error ? err.message : 'invalid token');
    }
  }
  // ... 后续 shape / token_version / exp 检查不变
}
```

`signLaifuUserToken` **不变**——永远用 `input.secret` (即 primary)。

所有调用点(`container-token.ts` middleware、`auth-refresh.ts`、`me-entitlements.ts` 等等)透传 `gatewaySecretPrevious` 进去。集中改一次 `config.auth` 即可。

### 3.2 ACA 容器侧

**`docker/hermes/server/http.ts`** `requireBearer` helper(本期 Task 4 引入)同样改成双 secret:

```ts
const SECRET = process.env.GATEWAY_SECRET!;
const SECRET_PREV = process.env.GATEWAY_SECRET_PREVIOUS || null;
const TV = Number(process.env.LAIFU_USER_TOKEN_VERSION);

function requireBearer(req: Request): Response | null {
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return Response.json({error:'unauthorized'}, {status:401});
  const token = auth.slice(7);
  try {
    verifyLaifuUserToken(token, { secret: SECRET, secretPrevious: SECRET_PREV, expectedTokenVersion: TV });
    return null;
  } catch { return Response.json({error:'unauthorized'}, {status:401}); }
}
```

容器不需要 sign,所以**没有**「永远用 primary」的语义,只有 verify fallback。

### 3.3 KV 侧

**bicep** 增加一项 secret name(默认不创建,只是声明 Gateway 会去 reference 这个 name):

```bicep
// infra/bicep/main.bicep, App Service appSettings 块新增:
GATEWAY_SECRET_PREVIOUS: '@Microsoft.KeyVault(VaultName=${kv.name};SecretName=gateway-secret-previous)'
```

**问题**:如果 `gateway-secret-previous` 这个 KV secret 不存在,App Service 启动时 KV reference resolve 会失败,gateway 启动炸(`known-issues #9`)。

**两种处理方式**:

#### 选项 A:始终保留一个 `gateway-secret-previous` 占位值

部署初始就在 KV 里 set `gateway-secret-previous = "__no_previous__"` (32 字节随便填一个废值)。Gateway 启动时 `verify` 永远不会真用到它(没人用这串 sign 过 token),功能上等价于 null。

**优点**:bicep 干净,KV reference 永远 resolve 成功。
**缺点**:多一个"假"secret 在 KV 里,误导。

#### 选项 B:bicep 不引用 PREVIOUS,只在轮换期临时 `az webapp config appsettings set` 注入

轮换流程多一步 inline appsettings set,但 KV 干净。

**推荐 A**——简单、不依赖运维记得加临时 appsettings,且 `__no_previous__` 这种值一眼看出含义。

### 3.4 ACA 那一边同理

bicep / `provisioning/azure.ts` 创建 ACA 时:

```ts
env: [
  { name: 'HERMES_API_KEY', secretRef: 'hermes-api-key' },
  { name: 'GATEWAY_BASE_URL', value: config.auth.publicBaseUrl },
  // 本期新增:
  { name: 'GATEWAY_SECRET',          secretRef: 'gateway-secret' },
  { name: 'GATEWAY_SECRET_PREVIOUS', secretRef: 'gateway-secret-previous' },
  { name: 'LAIFU_USER_TOKEN_VERSION',         value: String(tokenVersion) },
],
secrets: [
  { name: 'acr-password', value: acrPwd },
  hermesApiKeySecret,
  // 本期新增:
  {
    name: 'gateway-secret',
    keyVaultUrl: `${config.azure.hermesKvUri}/secrets/gateway-secret`,
    identity: config.azure.hermesAcaIdentityResourceId,
  },
  {
    name: 'gateway-secret-previous',
    keyVaultUrl: `${config.azure.hermesKvUri}/secrets/gateway-secret-previous`,
    identity: config.azure.hermesAcaIdentityResourceId,
  },
]
```

> ⚠️ 已过时:上面示例里的 `{ name: 'acr-password', value: acrPwd }` 现已不存在 —— 镜像拉取改走 Managed Identity (AcrPull),ACA spec 里不再有 acr-password secret(见 `dynamic-update-aca.md`)。本期落地此轮换时,secrets 数组只在 `hermes-api-key` 基础上加 `gateway-secret*` 两项即可。

---

## 4. 轮换 Runbook

### 4.1 计划性轮换(每年一次 / 怀疑泄露)

```bash
# ===== 前置 =====
# 必须先确认 Gateway + ACA 双方代码都已实现 §3 的 dual-secret 支持
# (本期 weichat-file-impl 完成后即满足)

KV=kv-lingxi-dev
RG=rg-lingxi-dev
APP=app-lingxi-dev-gateway

# ===== 阶段 1: KV 切换 =====
# 1.1 备份当前 primary 到 previous 槽位
CURRENT=$(az keyvault secret show --vault-name $KV --name gateway-secret --query value -o tsv)
az keyvault secret set --vault-name $KV --name gateway-secret-previous --value "$CURRENT" --output none

# 1.2 写入新 primary
NEW_SECRET=$(openssl rand -hex 32)
az keyvault secret set --vault-name $KV --name gateway-secret --value "$NEW_SECRET" --output none
echo "new gateway-secret set, fingerprint: ${NEW_SECRET:0:8}..."

# ===== 阶段 2: 让 Gateway 拉新值 =====
# App Service 不自动 re-resolve, 必须改 appsettings 触发 (known-issues #9)
az webapp config appsettings set -g $RG -n $APP \
  --settings "KV_REFRESH_TRIGGER=$(date +%s)" --output none
# 等 ~30s 让 App Service 重启完毕

# ===== 阶段 3: 让所有 ACA 拉新值 =====
# ACA 的 secrets[].keyVaultUrl 拉值时机: 启动时 + secret name 变更时
# 不会自动感知 KV value 变更, 必须主动重启每个 revision
pnpm tsx scripts/admin-rotate-secret.ts --propagate
# 脚本逻辑见 §5

# ===== 阶段 4: 观察 =====
# Kusto: AppServiceConsoleLogs | where ResultDescription has "TokenInvalidError"
# 共存期 (primary=S2, previous=S1) 应该 0 出现, 任何 verify 失败都是真异常

# ===== 阶段 5: 退役旧 secret (可选, 90 天后) =====
# 等所有 token 自然 refresh 完毕 (上限 90 天), 或主动跑全量重签
pnpm tsx scripts/admin-rotate-secret.ts --force-resign  # 主动一轮性

# 然后清理 previous
az keyvault secret set --vault-name $KV --name gateway-secret-previous --value "__no_previous__" --output none
az webapp config appsettings set -g $RG -n $APP \
  --settings "KV_REFRESH_TRIGGER=$(date +%s)" --output none
pnpm tsx scripts/admin-rotate-secret.ts --propagate
```

### 4.2 紧急轮换(怀疑实时泄露)

跳过共存期,接受短暂中断换取最快收敛:

```bash
# 1. 直接覆盖 primary, 不设 previous (或设成 __no_previous__)
NEW_SECRET=$(openssl rand -hex 32)
az keyvault secret set --vault-name $KV --name gateway-secret --value "$NEW_SECRET" --output none
az keyvault secret set --vault-name $KV --name gateway-secret-previous --value "__no_previous__" --output none

# 2. 同时 bump 所有 token_version (拒绝攻击者持有的 token)
pnpm tsx scripts/admin-rotate-secret.ts --bump-all-versions

# 3. 触发 Gateway + ACA 拉新值
az webapp config appsettings set -g $RG -n $APP --settings "KV_REFRESH_TRIGGER=$(date +%s)" --output none
pnpm tsx scripts/admin-rotate-secret.ts --propagate --force-resign

# 中断窗口 ≈ Gateway 重启时间 + 单个 ACA update 时间 × N
# 实测预估: N=10 用户 → ~3 min; N=100 → ~30 min
```

---

## 5. 配套 admin 脚本

**文件**:`scripts/admin-rotate-secret.ts` (新)

```bash
# 模式 1: 把当前 KV 里的值同步到所有 ACA (重启所有 revision 让它们拉新值)
pnpm tsx scripts/admin-rotate-secret.ts --propagate

# 模式 2: 主动给所有用户重签 token, 注入到对应 ACA, 重启容器
# (用于强制全量切到新 secret 签的 token, 不等自然 90 天过期)
pnpm tsx scripts/admin-rotate-secret.ts --force-resign

# 模式 3: bump 所有用户 token_version (紧急 revocation)
pnpm tsx scripts/admin-rotate-secret.ts --bump-all-versions

# 模式 4: 单用户操作 (debug 用)
pnpm tsx scripts/admin-rotate-secret.ts --user <uuid> --force-resign
```

**运行位置**:**运维人本地机器**(开发者 Mac / 跳板机),不是 Gateway 进程内。

**"本地脚本调云资源"不是矛盾**——参考已有 `scripts/verify-cloud-sas.ts`:它本地跑、用 `DefaultAzureCredential` 拿 `az login` 缓存的凭据、通过 ARM API 操作 Azure 上的 Storage Blob。我们要写的 `admin-rotate-secret.ts` 走完全相同的范式,只是换成 `@azure/arm-appcontainers` SDK 操作 ACA。

**实测确认权限可用**(2026-06-17, 账号 `shang542361224@163.com`):

| 操作 | 实测 |
|---|---|
| `az keyvault secret set/delete/purge` | ✓ |
| `az containerapp show` | ✓ 读到 `hermes-8a599ed4` 等用户 ACA |
| `az containerapp update --set-env-vars / --remove-env-vars` | ✓ 单次滚动 ~20s |

→ 等价于:**本机过了 `az login` 就具备所有运维能力**。Gateway 在 prod 用 managed identity 走同一套 ARM API,本地脚本用开发者 AAD 凭据走同一套 ARM API,两边代码可以完全一致。

### 5.1 依赖 env

脚本启动时检查并 fail-fast:

| env | 来源 | 用途 |
|---|---|---|
| `AZURE_SUBSCRIPTION_ID` | `az account show --query id -o tsv` 拷一份 | ARM client target |
| `AZURE_RESOURCE_GROUP` | 跟 Gateway env 一致 (`rg-lingxi-dev`) | ACA 所在 rg |
| `DATABASE_URL` | 跟目标环境 Gateway 一致 (dev 还是 prod) | 列用户 / 查 token_version / bump |
| `GATEWAY_SECRET` | `az keyvault secret show --vault-name <kv> --name gateway-secret --query value -o tsv` | 本机重签 JWT 用 |
| (隐式) `az login` 凭据 | `~/.azure/` | `DefaultAzureCredential` 自动 fallback |

**不需要**显式 `AZURE_CLIENT_ID/SECRET`——`DefaultAzureCredential` 链路会自动用 `az login` 缓存的 token。

### 5.2 实现骨架(可直接起步)

```ts
#!/usr/bin/env -S node --experimental-strip-types
/**
 * admin-rotate-secret.ts — secret 轮换运维脚本
 *
 * 跑法:
 *   az login                                 # 首次 / 凭据过期时
 *   export AZURE_SUBSCRIPTION_ID=...
 *   export AZURE_RESOURCE_GROUP=rg-lingxi-dev
 *   export DATABASE_URL=postgres://...       # 指向轮换的目标环境 DB
 *   export GATEWAY_SECRET=$(az keyvault secret show --vault-name kv-lingxi-dev --name gateway-secret --query value -o tsv)
 *
 *   pnpm tsx scripts/admin-rotate-secret.ts --propagate          # 只重启 ACA 让其拉新 KV 值
 *   pnpm tsx scripts/admin-rotate-secret.ts --force-resign       # 全量重签 token + inject + 滚动
 *   pnpm tsx scripts/admin-rotate-secret.ts --bump-all-versions  # bump token_version + 重签 (紧急)
 *   pnpm tsx scripts/admin-rotate-secret.ts --user <uuid> --force-resign   # 单用户 debug
 */
import { ContainerAppsAPIClient } from '@azure/arm-appcontainers';
import { DefaultAzureCredential } from '@azure/identity';
import { signLaifuUserToken } from '../apps/gateway/src/lib/gateway-token.js';
// 复用 gateway 已有的 DAO + provisioning 函数 (cross-package import 同 verify-cloud-sas.ts 范式):
import { dao } from '../apps/gateway/src/db/index.js';
import { appNameFor } from '../apps/gateway/src/provisioning/azure.js';

const SUB = requireEnv('AZURE_SUBSCRIPTION_ID');
const RG  = requireEnv('AZURE_RESOURCE_GROUP');
const SECRET = requireEnv('GATEWAY_SECRET');

const credential = new DefaultAzureCredential();
const client = new ContainerAppsAPIClient(credential, SUB);

type Mode = 'propagate' | 'force-resign' | 'bump-all-versions';

async function handleUser(userId: string, mode: Mode): Promise<void> {
  const appName = appNameFor(userId);

  if (mode === 'bump-all-versions') {
    await dao.entitlements.bumpTokenVersion(userId);
  }

  if (mode === 'force-resign' || mode === 'bump-all-versions') {
    const tv = await dao.entitlements.getTokenVersion(userId);
    if (tv == null) throw new Error(`no token_version for ${userId}`);
    const token = signLaifuUserToken({ userId, tokenVersion: tv, secret: SECRET });

    const current = await client.containerApps.get(RG, appName);
    const containers = current.template?.containers ?? [];
    if (containers.length === 0) throw new Error(`no containers in ${appName}`);
    const env = (containers[0]!.env ?? [])
      .filter((e) => e.name !== 'LAIFU_USER_TOKEN' && e.name !== 'LAIFU_USER_TOKEN_VERSION');
    env.push({ name: 'LAIFU_USER_TOKEN', value: token });
    env.push({ name: 'LAIFU_USER_TOKEN_VERSION', value: String(tv) });
    containers[0]!.env = env;
    await client.containerApps.beginUpdateAndWait(RG, appName, {
      location: current.location,
      template: { containers },
    } as any);
  } else {
    // propagate: 不改 env, 只重启让 secrets[].keyVaultUrl 重 resolve
    const app = await client.containerApps.get(RG, appName);
    const rev = app.latestRevisionName;
    if (!rev) throw new Error(`no revision for ${appName}`);
    await client.containerAppsRevisions.restartRevision(RG, appName, rev);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = (args.find((a) => a.startsWith('--')) ?? '--propagate').slice(2) as Mode;
  const singleUser = args[args.indexOf('--user') + 1];

  const userIds = singleUser
    ? [singleUser]
    : (await dao.users.listAllWithContainers()).map((u) => u.id);

  console.log(`[rotate] mode=${mode}, target=${userIds.length} users`);

  // 并发 ≤ 5: Azure ARM API 全局 rate limit ~1200 req/min, 单 sub 滚动操作建议保守
  const failures: Array<{ userId: string; err: string }> = [];
  const CONCURRENCY = 5;
  for (let i = 0; i < userIds.length; i += CONCURRENCY) {
    const batch = userIds.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (uid) => {
      try {
        await handleUser(uid, mode);
        console.log(`[rotate] ✓ ${uid}`);
      } catch (e) {
        failures.push({ userId: uid, err: e instanceof Error ? e.message : String(e) });
        console.error(`[rotate] ✗ ${uid}: ${e}`);
      }
    }));
  }

  if (failures.length > 0) {
    console.error(`\n[rotate] FAILED: ${failures.length}/${userIds.length}`);
    for (const f of failures) console.error(`  - ${f.userId}: ${f.err}`);
    process.exit(1);
  }
  console.log(`[rotate] all ${userIds.length} done`);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`${name} required`); process.exit(1); }
  return v;
}

main().catch((e) => { console.error(e); process.exit(1); });
```

### 5.3 设计要点

1. **复用 gateway 的 DAO / token 签发 / `appNameFor`**:cross-package import 同 `verify-cloud-sas.ts` 范式(脚本不在 workspace 里也能 import,因为 `tsx` 直接解析 ts source)。
2. **不复用 `provisioning/azure.ts` 里的 `reconcileContainerAppAzure`**(原 `signTokenAndInjectAzure` 已删除合并入它):那套依赖 gateway `config.ts` 整套 env (`config.auth.gatewaySecret` 等),脚本端走自己的简化路径更干净——只用纯函数 `signLaifuUserToken` + 自己拿 SDK client。
3. **限速**:并发 5。Azure ARM 全局 rate ~1200 req/min,本来不紧,但单 sub 短时间 N 个 ACA 同时滚动 revision 会触发 Container Apps 控制面排队,5 是经验值。
4. **幂等**:任一 user 失败不阻塞其它,最后汇总报告。重跑同一命令收敛到正确状态。
5. **`--propagate` vs `--force-resign` 的区别**:
   - `propagate`:不改 env,只 `restartRevision` → 容器重启 → `secrets[].keyVaultUrl` 重 resolve → 拿到新 KV 值。**用于 KV value 变了但 token 不用换的场景**(比如换 `previous` 槽位)。
   - `force-resign`:用当前 GATEWAY_SECRET 重签 token,inject 进 env,`beginUpdateAndWait` 自动滚动新 revision。**用于强制全量换代 token,不等 90 天自然过期**。
6. **依赖已有**:`@azure/arm-appcontainers ^2.2.0` 和 `@azure/identity ^4.13.1` 已在 `apps/gateway/package.json`,脚本直接 import 即可,无需新加。

---

## 6. 为什么不在 Gateway 内做 admin endpoint

| 维度 | 本地脚本(选) | Gateway 内 admin endpoint |
|---|---|---|
| 凭据 | 运维 `az login` + KV 拉 secret | Gateway 进程已有 |
| 攻击面 | 0 — 没有暴露的入口 | +1 — admin endpoint 哪怕加 auth 也是潜在跳板 |
| 失败可控 | ctrl-c 重跑;终端实时日志 | 中途断网失败要从 prod log 拼 |
| 跟现有约定一致 | ✓ `scripts/verify-cloud-sas.ts` 同款 | ✗ Gateway 目前没有 admin endpoint |
| 部署耦合 | 改脚本不需要重 deploy gateway | 每次改要触发 App Service rebuild |
| 触发频率 | 一年 1 次(计划)+ 极罕见紧急 | 同 |

**唯一前提**:运维本机 `az` CLI 已登录,`pnpm tsx` 工具链就绪,有 Azure RBAC `Contributor` 或 `Container Apps Contributor` + `Key Vault Secrets Officer`。当前账号已满足。

---

## 7. 验证清单

部署完 §3 的 dual-secret 实现后,在 dev 环境跑一遍验收:

| 测试 | 期望 |
|---|---|
| 当前稳态 (`previous=null`): callHermesChat | ✓ 成功 |
| 当前稳态: 容器 callback | ✓ 成功 |
| 设 `previous=旧值`, primary 不变: 全链路 | ✓ 跟未设一样 (因为 sign 还是用 primary, verify 也是 primary 先过) |
| **轮换共存期**: KV 切 primary→S2, previous=S1, 触发 propagate | ✓ 容器手里旧 token (S1 签) 继续 callback 成功 (走 previous fallback);新 chat 拿到 S2 签的 token, ACA 用 S2 verify 成功 |
| **退役**: 把 previous 抹掉, propagate | ✓ 此时仍能正常工作 (所有新 token 都是 S2 签的);单元测试模拟"如果还有 S1 签的 token 残留" → 应当 401 |
| 紧急 bump-all-versions 后 | ✓ 所有用户旧 token 全 401, 新 chat 自动续签 (容器 entrypoint refresh-token 拿当前 token_version 签的新 token) |
| 在 dev 上故意把 ACA 的 `GATEWAY_SECRET` env 改成错值, 不动 Gateway | ✓ 全部 chat 立刻 401, 验证容器侧 dual-secret 落地正确 |

---

## 8. 跟其它已知问题的关系

- `known-issues.md #9`:KV reference re-resolve 必须靠 `KV_REFRESH_TRIGGER` 触发 — Runbook 阶段 2 直接用这个机制。
- `known-issues.md #3`(ContainerMappingCache 陈旧 `container_url`):本设计**不受影响** — 轮换走 `reconcileContainerAppAzure`(原 `signTokenAndInjectAzure`)+ `restartContainerAppAzure`,这两个函数都直接调 Azure SDK,**不读 ContainerMappingCache**,直奔 ARM resource → 永远拿到最新 URL。
- `weichat-file-impl.md` §Task 4 "鉴权 (4 端点统一 Bearer)":本期实现是这套轮换机制的**前置条件** — 必须先把 ACA 侧 dual-secret verify 落地,才能在生产做无中断轮换。

---

## 9. TL;DR

- **不要** 直接改 KV 然后期望系统自愈 — 会全面 401, refresh-token 救不回来。
- **要** 走 dual-secret 共存期:`sign 永远用 primary, verify 接受 [primary, previous]`。
- **运维步骤**:KV 写新值 → 触发 App Service refresh → 跑 `admin-rotate-secret.ts --propagate` 让所有 ACA 拉新值 → 等 90 天或主动 `--force-resign` 全量换代 → 抹掉 previous → 收工。
- **脚本** `scripts/admin-rotate-secret.ts` 在**本地**跑(跟 `scripts/verify-cloud-sas.ts` 同款,用 `DefaultAzureCredential` 调云上 ARM),不是 Gateway 内 endpoint。
- **中断窗口** = 0(计划性轮换) 或 几分钟(紧急轮换 + bump)。
