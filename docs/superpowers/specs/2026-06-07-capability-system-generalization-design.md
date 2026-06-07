# 能力系统通用化设计(子项 A)

**日期**: 2026-06-07
**分支**: 建议另起 feat/capability-system
**状态**: Draft, pending user review
**关联**: 为 [2026-06-07-hermes-email-capability-design.md](./2026-06-07-hermes-email-capability-design.md)(子项 B)铺底;对齐原型 `docs/prototype/agentos-macos.html` 的能力模型

## 一、概要

把当前**特例化**的能力管理(云盘用专门的 `BuyCloudButton`/`DisableCloudButton`,默认能力 web/file/wechat 硬编码)重构成原型那套**数据驱动的通用能力系统**:一个能力目录(catalog)+ 装备/市场两个 tab + 通用装备/移除。之后云盘是目录里一条数据,邮件(子项 B)再加一条,**不再为每个能力写一对按钮**。

范围:**只做"能力",不做"专家团队/专家市场"**;**对齐原型的模型与流程,视觉沿用现有桌面风格**(来自 brainstorm 决策)。

### 为什么要先做这个

照现状加邮件 → 再写 `BuyEmailButton`/`DisableEmailButton`,特例债务翻倍。先通用化,邮件就只是往 catalog 注册一条。

### 现状 vs 原型(差距)

| | 原型(目标) | 现状 |
|---|---|---|
| 能力列表 | 数据驱动 `CAPS` 目录 + `ASSISTANT.caps` 已装备数组 | web/file/wechat **硬编码**,cloud 特例 |
| 管理界面 | **装备 / 市场 两个 tab** | 单页,市场只在未购云盘时露出 |
| 装备/移除 | 统一卡片 + ✕ 移除;「添加能力」→ 市场 | 云盘专属 `Buy/DisableCloudButton` |
| 加新能力 | catalog 注册一条 | 写一对 bespoke 按钮 |
| 目录内容 | web/file/wechat(免费默认)+ cal/**mail**/voice/img/report/db/code | 仅 web/file/wechat + **cloud**(原型里没有 cloud,有 mail 未做) |

> 注意:原型 catalog 有「邮件收发 ¥49」却没有「云盘」;实现反过来。**本次以"实现了的能力"为准**(web/file/wechat + cloud,随后 email),原型的 cal/voice/img/... 视为未来槽位。**对齐的是模型与流程,不是照搬 catalog 数据。**

### 不在本期

- 专家团队 / 专家市场(原型有,本次明确不做,但市场 UI 预留未来加 tab 的位置)
- 原型里未实现的能力(cal/voice/img/report/db/code):**不进 catalog、不放灰卡**(见 §六)
- 能力定价体系(framework 带 `price` 字段;v1 cloud=免费,email 价格由 product 定)
- 后端能力本身的逻辑(只动 entitlements 路由参数化)

---

## 二、能力目录(catalog,前端单一数据源)

新增 `apps/web/src/lib/capabilities.ts`,导出 catalog:

```ts
interface Capability {
  id: string;              // entitlement key, e.g. 'cloud' | 'email'
  icon: ReactNode;         // 复用 lib/icons
  name: string;            // 「云盘」
  blurb: string;           // 市场/确认弹窗副文案
  price: number;           // 0 = 免费;仅展示, 不影响逻辑
  removable: boolean;      // 默认能力 (web/file/wechat) = false
  desktopApp?: string;     // 装备后桌面出现的 app id, e.g. 'files';无则不进 Dock
  enableCopy: { title; desc; capacity? };   // 购买确认弹窗文案
  disableCopy: { title; desc };             // 退订确认弹窗文案
}
```

v1 条目:
| id | name | removable | desktopApp | 价格 | 来源 |
|---|---|---|---|---|---|
| web | 联网搜索 | 否 | — | 免费 | 默认(始终装备) |
| file | 文件读写 | 否 | — | 免费 | 默认 |
| wechat | 微信收发 | 否 | — | 免费 | 默认(绑定走现有微信流程) |
| cloud | 云盘 | 是 | files | 免费 | 现有,收编进 catalog |
| email | 邮件 | 是 | —(无收件箱 UI) | 待定 | 子项 B 注册 |

"已装备"判定:默认能力恒真;可选能力看 `entitlements.observed.includes(id)`。

---

## 三、ManageApp 重构(装备 / 市场 两 tab)

`apps/web/src/apps/manage/ManageApp.tsx` 改为原型结构:

```
我的助理
├─ [装备] tab
│   ├─ 头部卡:头像 / 名称 / 在线 · 套餐 · 微信绑定按钮   (沿用现有)
│   └─ 已装备能力 · N    [+ 添加能力 → 切到市场 tab]
│       └─ 卡片网格:catalog 中已装备者;removable 的右上角 ✕
└─ [市场] tab
    └─ 能力网格:catalog 全部;每卡显示「已装备」或「购买并装备」
       (预留未来「专家 Agent」分段, 本次只渲染「能力」)
```

状态:`STATE.manageTab: 'equip' | 'market'`(组件内 useState 即可)。

---

## 四、通用装备/移除组件(替换两个 bespoke 按钮)

抽出 `CapabilityAction.tsx`,把 `BuyCloudButton` + `DisableCloudButton` 的 desired/observed **轮询状态机**通用化(逻辑完全一致,只是文案和 feature id 参数化):

```ts
<CapabilityEquip cap={cap} />     // 市场卡片上的「购买并装备」+ 确认/轮询弹窗
<CapabilityRemove cap={cap} trigger={...} />  // 装备卡片 ✕ + 退订确认/轮询弹窗
```

- 复用现状的 `phase` 状态机(idle→confirm→posting→polling→ready/failed/timeout),`POLL_INTERVAL_MS`/`POLL_TIMEOUT_MS` 不变。
- ready 判定:`observed.includes(cap.id)`(enable)/ `!observed.includes(cap.id)`(disable)。
- 文案来自 `cap.enableCopy` / `cap.disableCopy`,不再写死云盘。
- **删除** `BuyCloudButton.tsx` / `DisableCloudButton.tsx`。

---

## 五、API & 后端参数化

**web `api.ts`**:`enableCloud()`/`disableCloud()` → 通用 `enableFeature(id)`/`disableFeature(id)`(打 `/api/entitlements/${id}/enable|disable`)。旧两个函数删除或留薄别名。

**gateway `entitlements.ts`**:路由 `/api/entitlements/cloud/(enable|disable)` → `/api/entitlements/:feature/(enable|disable)`,加**服务端白名单**(`['cloud','email']`,拒绝未知 feature)。底层 `deps.entitlements.enable(userId, feature)` DAO **已是参数化的,不动**。

**Dock/Desktop**:桌面出现哪些 app 由 catalog 的 `desktopApp` + `observed` 驱动(cloud→files)。现状 Desktop 已经 react observed,改为查 catalog 而非硬编码 cloud。email 无 `desktopApp`,不进 Dock。

---

## 六、目录只放已实现的能力(已定)

**只显示已实现的能力,不放"敬请期待"灰卡**(来自 brainstorm 决策)。原型市场列的 cal/voice/img/report/db/code 不进 catalog。

最终能力构成:
- **默认基线**(始终装备、`removable:false`、不可退订):联网搜索 / 文件读写 / 微信收发。
- **可装备/可退订**(在市场,走通用装备/移除):☁️ 云盘、✉️ 邮件。

catalog **不需要** `comingSoon` 字段(YAGNI)。

---

## 七、影响面 & 实现顺序

改动集中在 web `apps/manage/` + `lib/`,后端只动一个路由文件:

1. `lib/capabilities.ts` catalog + `lib/icons` 补 mail 图标(子项 B 用)。
2. `lib/api.ts` 通用 `enableFeature/disableFeature`。
3. gateway `entitlements.ts` 路由 `:feature` + 白名单。
4. `CapabilityAction.tsx` 通用组件;删 `Buy/DisableCloudButton.tsx`。
5. `ManageApp.tsx` 装备/市场 tab 重构。
6. Desktop/Dock 改 catalog 驱动。
7. 回归:云盘购买/退订/桌面 Files 出现消失,与改造前行为一致。

---

## 八、风险 / 取舍

- **回归风险**:云盘购买/退订是已上线功能,重构不能改变其行为(desired/observed 协议、轮询、桌面联动)。第 7 步必须端到端回归。
- **默认能力不可移除**:web/file/wechat 是基线,catalog `removable:false` 保证不出现 ✕,避免用户误关基础能力。
- **catalog 与后端白名单两处**:加新能力要同时改 `capabilities.ts` 和 gateway 白名单——和 env 三处守则同理,记进文档防漂移。
