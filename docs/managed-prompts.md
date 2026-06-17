# Managed system prompts — 实施现状

> 状态: **代码已实施, 等部署实测**。 (2026-06-05)
>
> 本文档是当前架构的事实记录。早期 WIP 讨论稿已被本版取代——其中有若干技术细节是**未经源码验证的瞎猜**, 实施过程中被逐一推翻:
>
> - ❌ 之前说 hermes config.yaml 支持 `model.system_message` 字段 — **不存在**, 源码里搜不到
> - ❌ 之前说 `HERMES_MD_NAMES` 是用户可配置的 env, 控制扫哪些 .md — **错的**, 源码里是写死的 tuple `(".hermes.md", "HERMES.md")`, first-match-wins
> - ❌ 之前说 `HERMES_EPHEMERAL_SYSTEM_PROMPT` "破坏 prompt cache" — **错的**, 只要 env 值稳定就 byte-stable, cache 命中正常
>
> 决策都基于这些错误前提推导, 重做了一遍。教训: **未经源码核实的技术细节不要写进设计文档**。

---

## 一、目标

让灵犀的 Hermes agent 拥有一套可被运营/开发热修改的 system prompt 管理机制:

1. 改了 prompt 之后, 通过简单的操作就能让新 session / ACA 重启后生效
2. 不希望每次改 prompt 都走繁重的发布流程 (重 build 镜像、改 bicep、推所有用户 secret 等)
3. 不污染对话历史
4. 不应该把 prompt 内容跟容器生命周期硬绑死 (env 一改才生效的方案太重)
5. 不破坏 hermes 的 prompt cache (改一次 = 一次 cache miss, 之后稳态命中)

---

## 二、Hermes 真实支持的 prompt 注入入口 (源码核实)

调研对象: `hermes-agent` repo, 路径 `agent/prompt_builder.py` / `agent/system_prompt.py` / `agent/agent_init.py` / `cli.py` / `agent/conversation_loop.py`。

| 入口 | 路径/形式 | 注入位置 | session 内会变? | 适合什么 |
|---|---|---|---|---|
| **`~/.hermes/SOUL.md`** | 文件, 写死路径 | cached / stable, session 起始一次 | ❌ | 长期人格/灵魂层 |
| **`.hermes.md` / `HERMES.md`** | cwd → git root, first-match | cached / context | ❌ | 项目级 prompt; 我们 server/ cwd 是 `/home/hermes` |
| **`AGENTS.md` / `CLAUDE.md` / `.cursorrules`** | 类似上面, first-match | cached / context | ❌ | 兼容其他 agent 生态 |
| **`config.yaml: agent.system_prompt`** | yaml 字段 | ephemeral, 每 turn 拼到 cached 后面 | 启动时读 env, 启动后不变 | 业务规则层 |
| **`HERMES_EPHEMERAL_SYSTEM_PROMPT`** env | env 字符串 | 同上 (优先级高于 config.yaml) | 同上 | 同上, 跟 env 同语义 |
| **`/personality`** | 用户在 CLI 输入 | session overlay | ✅ | 用户即时调风格 |
| **`/steer`** | 用户在 CLI 输入 | mid-run user message 注入 | ✅ (单次) | 引导单 turn |
| **`pre_llm_call` hook 插件** | Python | user message append | ✅ | 程序化扩展 |

**重要发现**: hermes 没有原生的"多 .md 文件 append-all 注入" 机制——所有 .md 类入口都是 first-match-wins。要分层只能在 gateway 端拼接好再下发, 或者写 hook 插件。

### `HERMES_EPHEMERAL_SYSTEM_PROMPT` 的真实行为 (源码核实)

```python
# agent/conversation_loop.py
effective_system = active_system_prompt or ""
if agent.ephemeral_system_prompt:
    effective_system = (effective_system + "\n\n" + agent.ephemeral_system_prompt).strip()
if effective_system:
    api_messages = [{"role": "system", "content": effective_system}] + api_messages
```

- 启动时从 env / config.yaml 读一次, 存 `agent.system_prompt`
- 每个 API 请求都拼到 cached system prompt **后面**, 作为同一个 system message
- **不进 session trajectory** (docstring 明确: "NOT saved to trajectories")
- 内容稳定 → `effective_system` 字节稳定 → **prompt cache 仍然命中** (上游早期理解错了)

---

## 三、现有方案

### 数据流

```
[运营]  vim apps/gateway/prompts/<name>.md → git commit → redeploy gateway
            │
            ▼
[gateway 启动]
  loadPromptStore(PROMPTS_DIR ?? cwd/prompts) → 内存:
    files:    name → 内容
    manifest: { version: 1, files: { name → sha256[:16] } }
            │
            ▼
[gateway 接口]
  GET /api/me/runtime-config     → 响应里带 prompts_manifest
  GET /api/me/prompts/:name      → 返回单文件内容 (text/markdown)
                                   鉴权复用 LAIFU_USER_TOKEN; name 白名单防穿越
            │
            ▼
[容器 bootstrap.ts] (每次冷启动)
  fetchRuntimeConfig → 拿到 prompts_manifest
  sync-prompts:
    跟 ~/dynamic_prompts/manifest.json diff
    Promise.allSettled 并行 GET 变化的文件 → ~/dynamic_prompts/<name>
    远端不再包含的 → 删 ~/dynamic_prompts/<name>
    更新 ~/dynamic_prompts/manifest.json
    副作用: 下载到 SOUL.md → 镜像写 ~/.hermes/SOUL.md
            │
            ▼
[hermes 行为]
  启动时读 ~/.hermes/SOUL.md → cached prompt
  /chat 时 server/hermes-proc.ts 读 ~/dynamic_prompts/system-prompt.md
        → 注入 HERMES_EPHEMERAL_SYSTEM_PROMPT 给子进程
        → hermes 拼到 cached 后, byte-stable 时 cache 命中
```

### 文件清单 (当前)

```
apps/gateway/prompts/
├── SOUL.md            ← 镜像到 ~/.hermes/SOUL.md, cached 层
└── system-prompt.md   ← 留在 ~/dynamic_prompts/, 由 server/hermes-proc.ts 注入 env
```

### Manifest 协议

```jsonc
// /api/me/runtime-config 响应里的 prompts_manifest 字段
{
  "version": 1,
  "files": {
    "SOUL.md":          "a3f2c1d4...",  // sha256[:16]
    "system-prompt.md": "9e8b7a6c..."
  }
}
```

容器侧 `SUPPORTED_VERSION = 1`; 远端 version 高于此 → 跳过同步, 保留本地老文件 (避免不兼容的解析破坏 volume)。本地 `~/dynamic_prompts/manifest.json` 同结构。

### 删除规则

- 远端 manifest 不含某文件 → 删 `~/dynamic_prompts/<name>`
- **不删** `~/.hermes/SOUL.md`: hermes 自带默认 persona, 删了破坏默认行为; 一旦镜像就保留, 直到下次 SOUL.md 又出现在 manifest 再覆盖
- system-prompt.md 不需要这种保留: `HERMES_EPHEMERAL_SYSTEM_PROMPT` 默认就是空, server/hermes-proc.ts 自动 unset 等于"回归默认"

---

## 四、决策记录

| 决策 | 结论 | 时间 |
|---|---|---|
| 主载体用 cached 类机制 | ✅ SOUL.md 走 cached; system-prompt.md 走 ephemeral 但同样 cache 友好 | 2026-06-04 |
| 不用 prefill_messages 做主方案 | ✅ 那是 few-shot 用的 | 2026-06-04 |
| Prompt 内容存 git, 不存 DB | ✅ | 2026-06-04 |
| Manifest push (inline env) vs Pull (HTTP) | ✅ Pull (作为整个 runtime-config pull 的一部分) | 2026-06-05 |
| 多 .md 文件分层管理 | ⚠️ hermes 原生不支持 append-all; 当前接受单 SOUL.md + 单 system-prompt.md | 2026-06-05 修正 |
| `LAIFU_USER_TOKEN` 鉴权 content endpoint | ✅ | 2026-06-04 |
| 按用户分组差异化 | 推后 (架构 ready, post-MVP 实现) | 2026-06-04 |
| Manifest 同步时机 | ✅ Pull 模型自然解决: 容器冷启动时 sync, "等用户下次冷启动"策略 | 2026-06-05 |
| Prompt 文件存放位置 | ✅ `apps/gateway/prompts/`, vite plugin 复制到 `dist/prompts/` | 2026-06-05 |
| 初版 prompt 文件结构 | ✅ `SOUL.md` + `system-prompt.md` 各一个文件 | 2026-06-05 |
| Hot-reload (改 .md 自动重算 sha) | ❌ 不做, 必须 redeploy gateway | 2026-06-05 |
| system-prompt.md 注入方式 | ✅ server/hermes-proc.ts (Phase 1 server.mjs / Python 时同) 运行时读文件注入 env, 不写 config.yaml | 2026-06-05 |
| Manifest 协议加 version 字段 | ✅ 留协议演进空间 | 2026-06-05 |
| config.yaml 写法 | ✅ Bun YAML partial merge (Phase 2 起内置, 此前 yaml@2 包), 只动 model.* 几个字段, 不重写整个文件 | 2026-06-05 |

---

## 五、未来扩展点 (post-MVP, 暂不做)

### 5.1 按用户分组差异化

gateway 端按 user_id 决定下发哪份 manifest:

```ts
function manifestFor(userId: string): PromptsManifest {
  const group = getUserPromptGroup(userId);  // 'default' / 'beta' / ...
  return manifest_by_group[group];
}
```

接口形状不变, 容器侧脚本零改动。

### 5.2 真正的多层 prompt

如果将来需要 `SOUL.md + BUSINESS.md + SAFETY.md` 都进 cached 层:

- **方案 A** (推荐): gateway 端拼成一个 SOUL.md 下发, 容器看到的还是单文件。改一处但分层只在 gateway 维护。
- **方案 B**: 写 hermes `pre_llm_call` hook 插件, 自定义读取多文件逻辑。重。

### 5.3 Chat-time reconcile

当前是"等用户下次 ACA 冷启动"才同步。如果运营改完 prompt 想"已在线用户也立即生效", 需要 gateway 拦截 `/chat`, 主动 `az containerapp revision restart`。复杂度中等, MVP 不做。

### 5.4 Hot-reload gateway prompts/

`fs.watch` 监听目录改自动重算 manifest, 不用重启 gateway 进程。10 行代码但有风险 (watcher leak / 启动慢), 当前不做。

---

## 六、已知坑

### 6.1 `~/.hermes/SOUL.md` 不可逆接管

一旦运营把 SOUL.md 放进 gateway prompts/, 容器一次同步就**永久覆盖** hermes 默认的 SOUL.md。后续就算从 prompts/ 删了, 容器侧也**不会**自动恢复 hermes 原版 (我们的删除规则就是不动这个文件)。

要恢复默认: 进容器 `rm ~/.hermes/SOUL.md`, 重启 hermes (它发现文件没了会用默认 persona)。

### 6.2 hermes 的 prompt cache 命中条件

`HERMES_EPHEMERAL_SYSTEM_PROMPT` 的内容变化 = 一次 cache miss。这是预期: **改一次, miss 一次, 之后稳态命中**。
但要注意 server/hermes-proc.ts 每次 `/chat` 都 `readFile` 后 `.trim()`——如果 prompt 文件被反复修改 (运营加空行、改标点等无意义变更), 每次都 miss。可以接受, 因为运营行为本来就该谨慎。

### 6.3 vite build 必须先成功才有 `dist/prompts/`

`copyPromptsPlugin` 在 vite `closeBundle` 钩子里复制。build-deploy.sh 从 `apps/gateway/dist/prompts/` 拷, 而不是源码目录——保证产物一致性。如果 vite build 跳过了 (比如部分 build), 部署包里就没有 prompts。校验加进 build-deploy.sh 是 follow-up。

---

## 七、相关代码入口

| 文件 | 作用 |
|---|---|
| `apps/gateway/src/lib/prompt-store.ts` | 启动时扫盘, manifest + content 内存 store |
| `apps/gateway/src/api/me-runtime-config.ts` | runtime-config 和 prompts/:name 两个端点 |
| `apps/gateway/vite.config.ts` | `copyPromptsPlugin`: build 时 cpSync 到 dist |
| `apps/gateway/prompts/` | 真实 prompt 文件存放处 |
| `docker/hermes/scripts/sync-prompts.ts` | manifest diff + 并行下载 + SOUL.md 镜像 |
| `docker/hermes/scripts/bootstrap.ts` | 编排入口 |
| `docker/hermes/server/hermes-proc.ts` `buildSubprocessEnv()` | 每次 chat 注入 HERMES_EPHEMERAL_SYSTEM_PROMPT |
| `packages/shared/src/contracts.ts` `RuntimeConfig` / `PromptsManifest` | 协议类型 |
