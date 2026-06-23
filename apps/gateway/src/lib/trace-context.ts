/**
 * trace-context — 进程内请求级关联上下文 (trace_id) 的隐式透传。
 *
 * 用 AsyncLocalStorage 在一次请求的整个异步链里携带 trace_id (及可选 ambient 字段),
 * 让 lib/logger.ts 的每条日志自动带上 —— 无需穿过函数签名、无需每处 log 手加字段。
 *
 * 流转:
 *   - ingress (全局中间件 / wechat dispatch) runWithTrace({ trace_id }) 起一个上下文。
 *   - 出站到容器 (aca-call / inbox-uploader) 读 getTraceId() 写 X-Trace-Id header。
 *   - 容器回调 (/internal/hermes-callback) 经同一中间件读回 header → 续上同一 trace_id。
 *
 * store 只放标量 id (trace_id, 以及按需 setTraceFields 补的 loop_id/thread_id 等),
 * logger 会把整个 store 并进日志行 (显式字段优先覆盖)。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface TraceContext {
  trace_id: string;
  [key: string]: unknown;
}

const als = new AsyncLocalStorage<TraceContext>();

/** 在给定 trace 上下文里跑 fn (及其全部异步后续)。 */
export const runWithTrace = <T>(ctx: TraceContext, fn: () => T): T => als.run(ctx, fn);

/** 当前上下文 (无则 undefined)。 */
export const currentTrace = (): TraceContext | undefined => als.getStore();

/** 当前 trace_id (无上下文时 undefined)。 */
export const getTraceId = (): string | undefined => als.getStore()?.trace_id;

/**
 * 往当前上下文补字段 (原地 mutate, 同一异步链内后续日志即可见)。
 * 典型用法: loop 创建后 setTraceFields({ loop_id })。无上下文时 no-op。
 */
export const setTraceFields = (fields: Record<string, unknown>): void => {
  const store = als.getStore();
  if (store) Object.assign(store, fields);
};
