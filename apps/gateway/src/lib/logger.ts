/**
 * 单行 JSON 日志。App Service 把每行 stdout 投递到 Log Analytics 的
 * AppServiceConsoleLogs.ResultDescription, KQL 里 `parse_json(ResultDescription)`
 * 就能按字段切片 (event/userId/e2e_ms/...)。
 *
 * 不引第三方 logger 是刻意的: 体积 + 全局副作用都不值, 这里 30 行够用。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogFields {
  event: string;
  [key: string]: unknown;
}

const emit = (level: LogLevel, fields: LogFields): void => {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
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
