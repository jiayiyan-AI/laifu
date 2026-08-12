// trace-context.ts — 容器内请求级关联上下文 (trace_id) 的隐式透传。
//
// 跟 gateway lib/trace-context.ts 同款: 用 AsyncLocalStorage 在一次请求的整个异步链
// (含 fire-and-forget 的 async chat + 心跳 setInterval + callback) 里携带 trace_id,
// 让 server/logger.ts 每条日志自动带上。
//
// 流转: index.ts 的 Bun.serve fetch wrapper 从 X-Trace-Id header 取 trace_id (缺则
// newTraceId() 兜底), runWithTrace 包住整个 handle() —— 连 http.request 访问日志都带。
// chat.ts postCallback 回调 gateway 时读 getTraceId() 写回 X-Trace-Id, 闭环到 gateway。
//
// Bun 1.3+ 完整支持 node:async_hooks 的 AsyncLocalStorage (含 timer / promise 传播)。

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

export interface TraceContext {
  trace_id: string;
  [key: string]: unknown;
}

const als = new AsyncLocalStorage<TraceContext>();

export const runWithTrace = <T>(ctx: TraceContext, fn: () => T): T => als.run(ctx, fn);

export const currentTrace = (): TraceContext | undefined => als.getStore();

export const getTraceId = (): string | undefined => als.getStore()?.trace_id;

/**
 * 兜底 trace_id: 仅当入站请求没带 X-Trace-Id 时用 (直连 / 测试 / health)。
 * 正常路径下 gateway 总会注入 header, 不走这里。前缀 tr_ 与 gateway 一致。
 */
export const newTraceId = (): string => `tr_${randomBytes(13).toString('hex')}`;
