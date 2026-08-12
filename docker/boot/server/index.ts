#!/usr/bin/env bun
/**
 * index.ts — Agent HTTP 包装层入口 (Bun.serve, 从 server.py 迁移)
 *
 * 接口:
 *   GET  /health  → 健康检查
 *   POST /chat    → body: {message, session_id, source, callback: {loop_id}}
 *                    立即 202; 后台跑 agent + 心跳 + result 回调 gateway
 *
 * 模块切分:
 *   boot/server/config.ts    HTTP、鉴权、附件与 callback 的通用配置
 *   boot/server/http.ts      Request → Response handler + 路由分发
 *   boot/server/callback.ts  heartbeat + Gateway result callback
 *   runtime/types.ts         boot 可依赖的 agent runtime contract
 *   runtime/select.ts        当前默认创建 Hermes runtime
 *   hermes/*                 Hermes CLI、SQLite、session map 与 config 私有实现

 * Runtime: Bun 1.3+, 用 Bun.serve 而非 node:http
 *   - Bun.serve 是 Bun 原生 HTTP API, 比 node:http polyfill 快 (内部走 uWS 不是 libuv)
 *   - Web 标准 Request/Response 模型, Response.json() 自动收敛 Content-Type/Length
 *   - server.stop(false) 自带优雅关闭 (等 in-flight 请求完成)
 *
 */

import { initializeRuntime } from './runtime-initialization.ts';
import { PORT } from './config.ts';
import { createHandler } from './http.ts';
import { log } from './logger.ts';
import { newTraceId, runWithTrace } from './trace-context.ts';
import { createRuntime } from '../../runtime/select.ts';


const runtime = createRuntime();
await initializeRuntime(runtime);
const handle = createHandler(runtime);

const server = Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  // 包一层访问日志 + 末端兜底 — handle() 内部已 try/catch 各 handler, 这里防漏
  async fetch(req) {
    // 续用 gateway 注入的 X-Trace-Id (缺则现签), 包住整个请求 → 含 http.request 在内的所有日志都带 trace。
    const traceId = req.headers.get('x-trace-id')?.trim() || newTraceId();
    return runWithTrace({ trace_id: traceId }, async () => {
      const start = Date.now();
      let response: Response;
      try {
        response = await handle(req);
      } catch (e) {
        log.error({ event: 'http.handler.error', err: (e as Error).message ?? String(e) });
        response = Response.json({ error: 'internal' }, { status: 500 });
      }
      const path = new URL(req.url).pathname;
      if (path !== '/health') {
        log.info({
          event: 'http.request',
          method: req.method,
          path,
          status: response.status,
          dur_ms: Date.now() - start,
        });
      }
      return response;
    });
  },
  // 连接层异常 (parse / abort 等), 跟 node:http server.on('clientError') 同位
  error(err) {
    log.error({ event: 'http.connection.error', err: (err as Error).message ?? String(err) });
    return Response.json({ error: 'bad request' }, { status: 400 });
  },
});

log.info({
  event: 'server.listening',
  host: server.hostname,
  port: server.port,
});

// Graceful shutdown: 收 SIGTERM/SIGINT 让 in-flight 请求完成, 10s 后强制退出
// server.stop(false) 等所有活动 request 走完才 resolve, 同时不接新连接。
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    log.info({ event: 'server.shutdown', signal: sig });
    setTimeout(() => process.exit(1), 10_000).unref();
    await server.stop(false);
    process.exit(0);
  });
}
