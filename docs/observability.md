# 可观测性 / Observability

## 一句话现状

所有 Azure 端日志(ACA 每用户 hermes 容器 + App Service gateway)统一进同一个
Log Analytics workspace `la-rg-lingxi-dev`,保留 30 天,Portal → Logs 用 KQL 查。

- ACA 容器 stdout/stderr → `ContainerAppConsoleLogs_CL` (Bicep 创建 CAE 时就接好的)
- ACA 平台事件(probe 失败 / OOM / scaler) → `ContainerAppSystemLogs_CL`
- App Service gateway stdout → `AppServiceConsoleLogs.ResultDescription`
- App Service HTTP 访问日志 → `AppServiceHTTPLogs_CL`

接 App Service 那条线是后加的,见 `infra/bicep/main.bicep` 里
`appServiceDiag` (`Microsoft.Insights/diagnosticSettings`)。

## gateway 怎么打业务日志

用 `apps/gateway/src/lib/logger.ts`,只输出**单行 JSON**:

```ts
import { log } from './lib/logger.js';
log.info({ event: 'my.event', user_id, ms: 123 });
```

不要 `console.log('msg', obj)` 多参拼接 — KQL 里 parse 起来很痛苦。

## ACA 调用指标(端到端耗时)

`apps/gateway/src/lib/aca-call.ts` 的 `callHermesChat()` 是 gateway 调每用户 hermes
ACA `/chat` 的唯一入口。它在调用前后埋了 `event=aca.chat.call`,字段:

| 字段 | 含义 |
|---|---|
| `chat_ms` | `POST /chat` 端到端耗时 (gateway 视角) |
| `reply_chars` | 回复字符数 |
| `status` | `ok` / `no_reply` / `http_<code>` / `error` |
| `user_id` / `thread_id` / `source` | 切片维度 |

**冷启动判断不放在业务路径里测**(那会让所有 chat 多一发 `/health` RTT,得不偿失)。
ACA `minReplicas=0`,冷启动事件由平台直接报到 `ContainerAppSystemLogs_CL`,跟
`aca.chat.call` 按 `ContainerAppName_s + TimeGenerated` join 出来即可,见下方 KQL。

## 常用 KQL

端到端 P50 / P95 (近 24h):

```kusto
AppServiceConsoleLogs
| where TimeGenerated > ago(24h)
| extend j = parse_json(ResultDescription)
| where j.event == "aca.chat.call" and tostring(j.status) == "ok"
| summarize p50=percentile(tolong(j.chat_ms), 50),
            p95=percentile(tolong(j.chat_ms), 95),
            n=count()
```

成功率 (按 status 分组):

```kusto
AppServiceConsoleLogs
| where TimeGenerated > ago(24h)
| extend j = parse_json(ResultDescription)
| where j.event == "aca.chat.call"
| summarize n=count() by tostring(j.status)
```

冷启动命中率 — 用平台日志的 scaler / 容器创建事件跟 chat 调用时间戳对齐
(以 chat 开始前 10s 内有 scale-from-zero 事件视作冷启):

```kusto
let chats = AppServiceConsoleLogs
  | where TimeGenerated > ago(24h)
  | extend j = parse_json(ResultDescription)
  | where j.event == "aca.chat.call"
  | extend user_id = tostring(j.user_id), chat_ms = tolong(j.chat_ms),
           container_app = strcat("hermes-", substring(user_id, 0, 8));
let starts = ContainerAppSystemLogs_CL
  | where TimeGenerated > ago(24h)
  | where Reason_s has "ScalingReplicaSet" or Log_s has "Started container"
  | project start_ts = TimeGenerated, container_app = ContainerAppName_s;
chats
| join kind=leftouter (starts) on container_app
| extend cold = isnotnull(start_ts) and start_ts between (TimeGenerated - 10s .. TimeGenerated)
| summarize cold=countif(cold), warm=countif(not(cold)), total=count(),
            cold_p95_ms=percentile(iff(cold, chat_ms, long(null)), 95),
            warm_p95_ms=percentile(iff(not(cold), chat_ms, long(null)), 95)
```

(`container_app` 命名规则跟 `apps/gateway/src/provisioning/azure.ts` 对齐,
按需调整 substring。)

某个用户最近的失败:

```kusto
AppServiceConsoleLogs
| where TimeGenerated > ago(6h)
| extend j = parse_json(ResultDescription)
| where j.event == "aca.chat.call" and tostring(j.status) != "ok"
| where tostring(j.user_id) == "u_xxx"
| project TimeGenerated, j.status, j.chat_ms, j.err
```

ACA 平台事件 (容器重启 / OOM / scaler):

```kusto
ContainerAppSystemLogs_CL
| where TimeGenerated > ago(6h)
| project TimeGenerated, ContainerAppName_s, Reason_s, Log_s
```

## CLI 查日志

```bash
WID=$(az monitor log-analytics workspace show -g rg-lingxi-dev -n la-rg-lingxi-dev --query customerId -o tsv)
az monitor log-analytics query -w "$WID" --analytics-query \
  'AppServiceConsoleLogs | where TimeGenerated > ago(10m) | extend j=parse_json(ResultDescription) | where j.event=="aca.chat.call" | project TimeGenerated, j.chat_ms, j.status'
```

## 想加新指标怎么办

1. 直接 `log.info({ event: 'xxx', ... })`,字段名走 snake_case,数值用 number(不要塞字符串)。
2. 不需要建表 / DCR,Log Analytics 落到通用 `ResultDescription` 即可,KQL `parse_json` 取字段。
3. 不要打 PII (邮箱 / 微信昵称等);用 `user_id` 这种 opaque id 即可。

## 不在本仓的东西

- Application Insights(分布式 trace、Application Map):没开。当 `event=` 日志切片不够用时再加。
- Metric Alert / 通知:没配。
