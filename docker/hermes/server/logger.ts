// logger.ts — 单行 JSON 日志, 跟 gateway apps/gateway/src/lib/logger.ts 同款 schema。
//
// 容器 stdout/stderr 由 CAE appLogsConfiguration 投递到 Log Analytics 的
// ContainerAppConsoleLogs_CL.Log_s, KQL 里 `parse_json(Log_s)` 就能按字段
// (event/user_id/dur_ms/...) 切片, 跟 gateway 侧 parse_json(ResultDescription) 对齐。
//
// 不引第三方 logger 是刻意的 (跟 gateway 一致): 容器内 Bun 直跑 .ts, 30 行够用。
// user_id 自动从 config.USER_ID 注入 —— 每用户独占一个容器, 不必每处手传;
// dev 未注入 (空) 时省略该字段。

import { USER_ID } from './config.ts';
import { currentTrace } from './trace-context.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogFields {
  event: string;
  [key: string]: unknown;
}

const emit = (level: LogLevel, fields: LogFields): void => {
  // user_id 来自 config (容器即单用户); trace 上下文 (trace_id 等) 来自 ALS; 显式 fields 优先覆盖。
  const trace = currentTrace();
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    ...(USER_ID ? { user_id: USER_ID } : {}),
    ...(trace ?? {}),
    ...fields,
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

export const log = {
  debug: (fields: LogFields) => emit('debug', fields),
  info: (fields: LogFields) => emit('info', fields),
  warn: (fields: LogFields) => emit('warn', fields),
  error: (fields: LogFields) => emit('error', fields),
};
