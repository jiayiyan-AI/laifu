# 已知问题与运行规则

> 配套：[architecture.md](./architecture.md) · [deployment.md](./deployment.md) · `docker/hermes/`

---

## 🔴 必须遵守的规则

### #1 任何上 ACA 的 HTTP server 必须支持并发

- **原因**：ACA 的 readiness/liveness probe 每 5s 打一次 `/health`, 5 次失败后强杀容器。单线程 server 处理 chat 时无法响应 health, 必死。
- **规则**：
  - HTTP server 必须能并发处理请求 (Python 用 `ThreadingHTTPServer`、Node 默认即可)
  - `/health` 必须独立、轻量、不与业务共享阻塞资源
  - 本地测试矩阵应加"并发 chat + health"组合
  - Azure 出诡异行为先翻 `az containerapp logs show --type system`
- **现状**:`docker/hermes/server.py` 已用 `ThreadingHTTPServer` 落实 (见末尾 `main()` 注释)。**加新容器时这条规则仍然适用**。

---

## 🟡 当前未触发但留意

### #2 ACA Ingress 4 分钟超时

- **现象**：单个 HTTP 请求超过 240s 会被 ACA Ingress 强切。
- **当前架构**：Gateway → Container 用同步 `POST /chat` 调用 (`apps/gateway/src/api/chat.ts:45`),理论上仍受这个上限制约。
- **为什么暂时没事**：当前 LLM 是 DashScope qwen-plus, 普通对话回复都在秒级,远低于 240s。
- **何时会爆**:
  - hermes 跑复杂 shell 工具链 (`npm install -g`、长时间 build)
  - 切换到更慢的模型或在响应里嵌入大量工具调用
- **应对预案**:真要碰到再切异步 (gateway 立刻返回 ack, container 跑完通过 SSE 或 webhook 回推)。改动面不小, 当前不做。

---

## 🟢 已知能接受 (短期不处理)

### #3 ~~`tirith security scanner` 警告污染回复~~ — **已修**

- 历史现象:每次 `/chat` 响应正文前会多一行 `⚠ tirith security scanner enabled but not available ...`
- 修法:`docker/hermes/server.py:_clean_reply()` (大约第 133 行) 把 `⚠️ / ⚠ / [server]` 开头的行整行剔除, 第 290 行调用。
- 留作记录: hermes 上游版本若改告警前缀, 这个清洗逻辑要跟着更新。

### #4 PATH 中 `~/.local/bin` 优先于 `~/.npm-global/bin`

- **现象**：同名命令时 pip 版本优先于 npm 版本 (`docker/hermes/Dockerfile:75`)。
- **影响**：真实场景工具命名极少冲突。
- **应对**：不管。

### #5 Hermes 主动"教育"用户用结构化 memory 而不是 .txt

- **影响**：测试方法选择问题, 与架构无关。
- **应对**：真实平台上 Hermes 自己用 `~/.hermes/memories/` 管理。
