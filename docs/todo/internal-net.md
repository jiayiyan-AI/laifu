# ACA 内网化调研笔记

> 配套:[architecture.md](../architecture.md) · [known-issues.md](../known-issues.md) · [weichat-file-impl.md](./weichat-file-impl.md) §6 #5
>
> 本文是研究记录,**不是实施 plan**。决定动手的时候直接照这份做技术选型。

---

## 1. 问题

`docker/hermes/server/http.ts` 4 个业务端点(`/chat` `/history` `/session` `/inbox/image`)今天**全部裸奔**,只靠"container_url 不公开"撑安全。

### 攻击面有多大

容器命名是确定性算法 (`apps/gateway/src/provisioning/azure.ts:27`):

```ts
const appNameFor = (userId: string): string => `hermes-${userId.replace(/-/g, '').slice(0, 8)}`;
```

完整 FQDN:

```
https://hermes-a3f7c2d1.proudcoast-12345678.eastasia.azurecontainerapps.io
        └─ 8 hex chars     └─ envSuffix(全员共享)     └─ 已知
```

- envSuffix 在任何 container HTTP 错误响应、Azure portal 截图、DNS 反查里都能看到
- region 是已知 `eastasia`
- 真正的"秘密"只有 **8 个 hex = 32 bit 熵 ≈ 43 亿**

不是穷举不到,只是要花点钱扫一会儿。扫到一个就能直接调 `/chat` 烧那个用户的 LLM 配额、读对方对话历史。**这是已存在的生产隐患,不是图片 feature 引入的。**

### 当前网络拓扑

```
Internet
   │
   ├─ App Service (gateway, B1)     ── 公网入口 ─→  用户/微信
   │     └─ 出站:公网 TLS
   │           ↓ (HTTPS, 公网回环)
   │
   ├─ CAE (managedEnvironments)
   │     vnetConfiguration.internal: false   ← infra/bicep/main.bicep:168
   │     每个 per-user ACA 都有公网 FQDN
   │
   ├─ VNet (10.20.0.0/16)
   │     caeSubnet (10.20.0.0/23)
   │       └─ CAE delegate 用,Microsoft.Storage Service Endpoint
   │
   └─ NFS Storage (Premium FileStorage)
         defaultAction: Deny + 只允 caeSubnet
         ← 数据底层已锁死,不在攻击面内
```

**核心矛盾**:VNet 是有的(NFS 挂载要求),但 ingress **故意配的公网模式**。这是早期 MVP 的选择,后来 NFS 把 VNet 拉起来了,但 ingress 没顺手切。

---

## 2. 三条解法

| 路线 | 安全强度 | 月费增量 | 工时 | Migration 风险 |
|---|---|---|---|---|
| **A. Bearer only** | 应用层 JWT | $0 | ~0.5d | 无 |
| **B. Bearer + IP allowlist** | 网络 + 应用双层 | $0 | ~0.75d | 无 |
| **C. Bearer + 内网 CAE** | 真·内网 | < $1 | 3–5d 单独 PR | **有** — CAE 不可在原 env 改 internal,要新建 + 数据迁移 |

详细展开见 §3–§5。

### 路线 A — Bearer only (已在 `weichat-file-impl.md` Task 4 落地)

- `docker/hermes/server/http.ts` 加 `requireBearer(req)` helper
- 4 端点 dispatch 时统一套上(`/health` 留给 ACA probe 不校)
- gateway 出站 `apps/gateway/src/lib/aca-call.ts` 加 `Authorization: Bearer <signLaifuUserToken(...)>`
- 签 + 验都复用现有 `LAIFU_USER_TOKEN` + `apps/gateway/src/lib/gateway-token.ts`

**够不够安全**:阻断"扫到 URL 就能调用"。JWT secret 在 Key Vault,泄漏窗口比 URL 小一个数量级。

**不解决**:ACA 仍然公网可达,可被 DDoS、指纹、TLS 探测。

### 路线 B — IP allowlist (本期之外可考虑追加,但本次不做)

ACA ingress 支持 `ipSecurityRestrictions` (CIDR allowlist)。App Service B1 的 outbound IP 集**是稳定且公开的**(每个 plan 一组 ~6–10 个 IP,Portal "属性"页可查)。

```bicep
ingress: {
  external: true,
  targetPort: 8080,
  ipSecurityRestrictions: [
    { name: 'allow-app-service', ipAddressRange: '<appsvc-out-1>/32', action: 'Allow' },
    // ... 把 App Service plan 的 6-10 个出站 IP 全列上
  ],
}
```

**好处**:网络层堵掉 99% 攻击者(不需要先攻破我们 gateway 也能调 ACA 的可能性归零),钱仍是 $0,无 migration。

**脆弱点**:App Service 出口 IP 集**可能在升级 plan 时换**(B1 → S1 / regional 迁移),需要运维同步更新 Bicep。今天 B1 不动就稳。

### 路线 C — 内网 CAE + App Service VNet Integration

最干净的方案,**但 migration 代价大**,见 §5。

---

## 3. 钱的部分(高置信度)

| 项目 | 月费 | 依据 |
|---|---|---|
| CAE 改 `internal:true`(只切内部 LB,不开 PE) | **$0** | Microsoft Learn ingress 文档:internal/external 只是选 LB,**没有独立 ingress 费**。我们 `docs/known-issues.md:137` 提到的 €2/天是 Private Endpoint 专属 |
| App Service B1 Regional VNet Integration | **$0** | Microsoft Learn VNet Integration 文档:B1 起免费支持,feature 不收费 |
| Private DNS Zone(1 zone + 链 VNet) | **$0.50/zone/月 + $0.40/百万查询** | Azure DNS 定价表 (2026 retail);1 个 zone 我们用量 < $1/月 |
| **路线 C 总计** | **< $1/月** | |

**前提:严格避开 §4 的三个雷区**,任一踩到都会跳出 $32–65/月的账单。

---

## 4. 三个雷区(不能踩)

### 雷区 1:给 CAE 加 Private Endpoint

- 触发 "Dedicated Plan Management" 计费,~$0.09/小时 ≈ **$65/月 per environment**
- 同时适用 Consumption 和 Dedicated plan(微软文档明示)
- **我们不需要 PE**:internal LB 已经把入口锁在 VNet,PE 是额外锁存量(从 VNet 外的特定服务过来要走 Private Link)
- 决策:**保留 internal LB,不开 PE**

### 雷区 2:切到 Workload Profile Dedicated 套餐

- 同样触发 "Dedicated Plan Management" ~$65/月
- 微软在推 Workload Profiles 取代 Consumption-only(后者标为 legacy),但 **Consumption-only 完全支持 internal 模式**,只是有一些限制(子网 /23 起、UDR 受限、无 ExpressRoute)
- 我们当前 `caeSubnet=10.20.0.0/23`(`infra/bicep/main.bicep:108`)**正好满足** /23 要求,**不用改子网**
- 决策:**保持 Consumption-only 环境,只翻 `internal` flag**

### 雷区 3:App Service `vnetRouteAllEnabled: true`

- 默认是 `false`,意思是:
  - 出 VNet 内部地址(去 ACA 内网 FQDN)→ 走 VNet ✓
  - 出公网(DashScope LLM / Resend / Postmark / Google OAuth / 微信 iLink CDN)→ 仍走 App Service 自带公网出口 ✓
- 如果误设 `true`,**所有公网出站强行走 VNet**,而 VNet 没装 NAT Gateway → 全部 timeout。修复要么装 NAT Gateway(~$32/月 基础费 + per-GB 流量),要么挂公网 IP
- 决策:**保持默认 false,不动 NAT,零成本**

---

## 5. 路线 C 的 migration 现实(关键发现)

**CAE 的 `vnetConfiguration.internal` 是 immutable property。**

源:Microsoft Learn ARM schema + Terraform `azurerm_container_app_environment` 标了 `ForceNew`。**事后改不了**,只能:

1. **新建一个 CAE**(`internal:true`),跟原 external CAE 并存
2. NFS storage binding 在新 CAE 里**重新注册一次**(`apps/gateway/src/provisioning/azure.ts:67` 的 `SHARED_BINDING_NAME`)
3. **写迁移脚本**,遍历 `container_mapping` 表,逐用户:
   - 在新 CAE 里 create 对应的 hermes-* ACA(复用 `createContainerApp`)
   - 等 ready 拿**新的 internal FQDN**
   - update `container_url` DB 行
   - 等 in-flight 请求结束,删旧 ACA
4. App Service 加 VNet Integration + 新建 Private DNS Zone (`<envSuffix>.<region>.azurecontainerapps.io`),链到 VNet,加 A 记录指向新 CAE 静态 IP
5. **灰度方案**(二选一):
   - **新老分流**:provisioning 默认 env 改成新 CAE,新用户直接进;老用户后台异步迁(每个用户 chat 时检测一次,空闲时迁)
   - **停服窗口一把切**:某个低峰小时,把所有 50 个用户一起迁
6. 跑稳 ≥ 1 周后,删旧 CAE

**风险点**:

- 迁移瞬间该用户 chat 会断 ~30s(新 ACA 冷启动)
- 迁移脚本要**可重入、可回滚**(中途失败不能让用户卡在 limbo)
- 演练至少一轮 dev 全套
- 必须验证新 CAE 也能挂上同一个 NFS share(理论上 storage binding 重建就行,但要测)
- `apps/gateway/src/provisioning/azure.ts` 的 provisioning 代码要支持"指定 env name"参数(目前可能写死了)

**工时**:**3–5 day**(不是 1–2d)。主要是迁移脚本 + 演练 + 灰度,代码本身改动量不大。

---

## 6. 当前决议(2026-06-17)

**图片 feature PR(`weichat-file-impl.md`)走路线 A**,理由:

- A 在图片 PR 里**几乎是免费的**:`/inbox/image` 反正要写 Bearer,顺手把 `/chat` `/history` `/session` 一起套上多 4 行代码
- B 跟 C 都跟图片 feature 解耦,**独立 PR 更容易回滚**,不增加图片 feature 的失败半径
- 钱不增加(A B 都 $0)
- 后续 B 跟 C 任何时候都能在 A 基础上叠加,不会冲突

**已落地**:`docs/todo/weichat-file-impl.md` §6 #5、Task 4 鉴权小节、§4 文件清单。

---

## 7. 后续推荐

### 短期(1–2 个月内,有空就做)

**路线 B**(IP allowlist),0.25d 工作:

- Bicep 在 `createContainerApp` 的 ingress 配置加 `ipSecurityRestrictions`,allowlist App Service B1 plan 的出站 IP 集
- App Service 出站 IP 在 Portal "属性 → Outbound IP addresses" 拿(也可 `az webapp show ... --query outboundIpAddresses`)
- 写注释:**App Service plan 升级或迁 region 时记得同步更新此列表**
- 验证:从 App Service 外的机器调一下 ACA 应该被 403/403,从 App Service 内调应该正常

### 中期(半年内,看安全审计或外部需求决定要不要做)

**路线 C**(内网 CAE),3–5d:

- 触发条件:
  - 安全审计要求"无公网入口"
  - 用户数据敏感度升级
  - 引入企业客户合规要求
- 如果只是为了"防扫描",**B 已经够用**。C 主要是 compliance / 完美主义价值

### 永远不做(除非业务模型大变)

- Private Endpoint —— $65/月白烧,我们没有"Private Link 入站"的场景
- 升 Workload Profile Dedicated —— 失去 scale-to-zero 这个核心成本结构
- NAT Gateway —— 只在 `vnetRouteAllEnabled:true` 时才需要,我们不开

---

## 8. 引用源

### 微软官方

- [Container Apps Ingress overview](https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview) — internal/external 定义
- [VNet integration (custom internal)](https://learn.microsoft.com/en-us/azure/container-apps/vnet-custom-internal) — Consumption-only 内网模式 + `/23` 子网要求
- [App Service VNet Integration overview](https://learn.microsoft.com/azure/app-service/overview-vnet-integration) — B1 起免费支持
- [Container Apps pricing](https://azure.microsoft.com/en-us/pricing/details/container-apps/) — Dedicated Plan Management 费率
- [Azure DNS pricing](https://azure.microsoft.com/en-us/pricing/details/dns/) — Private DNS Zone $0.50/月 + $0.40/百万查询
- [Configure private endpoints for ACA](https://learn.microsoft.com/en-gb/azure/container-apps/private-endpoints-with-dns) — PE 触发 $65/月 management 费的明示
- [`Microsoft.App/managedEnvironments` ARM schema](https://learn.microsoft.com/en-us/azure/templates/microsoft.app/managedenvironments) — `vnetConfiguration.internal` 字段

### 项目内交叉引用

- `infra/bicep/main.bicep:155-171` — CAE 配置(当前 `internal:false`)
- `infra/bicep/main.bicep:99-119` — VNet + caeSubnet 现状
- `infra/bicep/main.bicep:220-237` — App Service 配置(当前无 VNet Integration)
- `apps/gateway/src/provisioning/azure.ts:27` — `appNameFor` 命名算法(32 bit 熵)
- `apps/gateway/src/provisioning/azure.ts:176-180` — per-user ACA `external:true` ingress
- `apps/gateway/src/lib/gateway-token.ts:58` — `signLaifuUserToken`
- `apps/gateway/src/auth/container-token.ts` — `verifyLaifuUserToken` 用法
- `docs/known-issues.md:137` — Private Endpoint €2/天费用历史记录
- `docs/architecture.md:135-140` — CAE 选型背景
- `docs/todo/weichat-file-impl.md` §6 #5 — 本期 Bearer 决议,Task 4 实现细节
