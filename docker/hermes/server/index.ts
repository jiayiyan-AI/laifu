#!/usr/bin/env bun
/**
 * index.ts — Hermes HTTP 包装层入口 (Bun.serve, 从 server.py 迁移)
 *
 * 接口:
 *   GET  /health  → 健康检查
 *   GET  /history?session_id=NAME → 拉某 session 历史 (直读 ~/.hermes/state.db)
 *   POST /chat    → body: {message, session_id, source, callback?: {loop_id}}
 *                    无 callback → 同步, 200 返回 {reply, session_id, hermes_session_id, exit_code, usage}
 *                    有 callback → 异步, 立即 202; 后台跑 hermes + 心跳 + result 回调 gateway
 *
 * 模块切分:
 *   config.ts       env 常量 + LAIFU_USER_TOKEN
 *   session-map.ts  gateway_name ↔ hermes_uuid 映射 + 锁
 *   state-db.ts     bun:sqlite 只读封装 (snapshot / messages / decode)
 *   hermes-proc.ts  spawn + 进程组杀 + ID 提取 + cleanReply + dyn prompt 注入
 *   chat.ts         callHermes + asyncChatAndCallback + postCallback
 *   http.ts         Request → Response handler + 路由分发
 *   index.ts        本文件: Bun.serve + 信号处理 + 访问日志
 *
 * 跟 Python 版差异 (在 hermes-proc.ts / chat.ts 各自模块注释里有详细):
 *   - HERMES_TIMEOUT 默认 300s → 14400s (4h, 见 config.ts)
 *   - subprocess 超时杀整个 process group (SIGTERM → 3s → SIGKILL), 不留孤儿
 *   - callback 重试退避走 httpJsonRetry 默认 exp backoff (Python 是 [2/8/30]s)
 *
 * Runtime: Bun 1.3+, 用 Bun.serve 而非 node:http
 *   - Bun.serve 是 Bun 原生 HTTP API, 比 node:http polyfill 快 (内部走 uWS 不是 libuv)
 *   - Web 标准 Request/Response 模型, Response.json() 自动收敛 Content-Type/Length
 *   - server.stop(false) 自带优雅关闭 (等 in-flight 请求完成)
 */

import { PORT, HERMES_TIMEOUT_MS } from './config.ts';
import { handle } from './http.ts';

const server = Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  // 包一层访问日志 + 末端兜底 — handle() 内部已 try/catch 各 handler, 这里防漏
  async fetch(req) {
    const start = Date.now();
    let response: Response;
    try {
      response = await handle(req);
    } catch (e) {
      console.error('[server] handler error:', e);
      response = Response.json({ error: 'internal' }, { status: 500 });
    }
    const path = new URL(req.url).pathname;
    if (path !== '/health') {
      console.log(`[server] ${req.method} ${path} ${response.status} ${Date.now() - start}ms`);
    }
    return response;
  },
  // 连接层异常 (parse / abort 等), 跟 node:http server.on('clientError') 同位
  error(err) {
    console.error('[server] connection error:', err);
    return Response.json({ error: 'bad request' }, { status: 400 });
  },
});

console.log(
  `[server] listening on ${server.hostname}:${server.port} (HERMES_TIMEOUT=${HERMES_TIMEOUT_MS / 1000}s)`,
);

// Graceful shutdown: 收 SIGTERM/SIGINT 让 in-flight 请求完成, 10s 后强制退出
// server.stop(false) 等所有活动 request 走完才 resolve, 同时不接新连接。
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    console.log(`[server] received ${sig}, shutting down`);
    setTimeout(() => process.exit(1), 10_000).unref();
    await server.stop(false);
    process.exit(0);
  });
}
