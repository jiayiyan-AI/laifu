// 共享工具: HTTP(S) 请求 / 读 token / 日志。零三方依赖, 走 Bun 内置 fetch + node:fs。
//
// 设计:
//   - httpJson 用 Bun 内置 fetch (Bun.fetch === globalThis.fetch), 比 node:https 简洁,
//     timeout 走 AbortSignal.timeout (Bun 支持)。返回 {status, body} 跟老接口完全兼容,
//     所有 caller 无需改。
//   - 其他纯文件 / 日志函数沿用 node:fs (Bun 完全支持 node: 前缀模块)。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export const HOME_DIR = '/home/hermes';
export const TOKEN_FILE = `${HOME_DIR}/.hermes/.laifu_user_token`;

export function log(msg: string): void {
  console.log(`[bootstrap] ${msg}`);
}
export function warn(msg: string): void {
  console.error(`[bootstrap] WARN: ${msg}`);
}

/**
 * 读 LAIFU_USER_TOKEN: 先 env, 再 fallback token 文件 (持久化在 home volume)。
 * Fallback 场景: dev 模式 docker restart 时 env 没新值; 或 prod 容器自然重启。
 */
export function readToken(): string {
  const fromEnv = process.env['LAIFU_USER_TOKEN'];
  if (fromEnv) return fromEnv;
  if (existsSync(TOKEN_FILE)) {
    return readFileSync(TOKEN_FILE, 'utf8').trim();
  }
  return '';
}

export function writeToken(token: string): void {
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
}

/** base64url decode (Node 原生支持, 不需要换 chars) */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('not a jwt');
  const json = Buffer.from(parts[1], 'base64url').toString('utf8');
  return JSON.parse(json);
}

export interface HttpJsonOpts {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | object | null;
  timeoutMs?: number;
}

export interface HttpJsonResult {
  status: number;
  body: string;
}

/**
 * 简单 HTTP(S) 请求 helper, 仿 fetch 接口但收敛返回成 {status, body}。
 * 默认 10s timeout。不做 redirect, 不做 retry — 调用方按需自己包 (见 httpJsonRetry)。
 */
export async function httpJson({
  method,
  url,
  headers,
  body,
  timeoutMs = 10_000,
}: HttpJsonOpts): Promise<HttpJsonResult> {
  const bodyStr =
    body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body);

  const finalHeaders: Record<string, string> = {
    ...(body && typeof body !== 'string' ? { 'Content-Type': 'application/json' } : {}),
    ...(headers ?? {}),
  };

  try {
    const res = await fetch(url, {
      method,
      headers: finalHeaders,
      body: bodyStr || undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    return { status: res.status, body: text };
  } catch (e: unknown) {
    // AbortError (timeout) 走和老版本一致的报错形状
    const err = e as { name?: string; message?: string };
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`request timeout after ${timeoutMs}ms`);
    }
    throw e;
  }
}

/**
 * httpJson + 解析 JSON body, 兼带简单 retry (exp backoff)。
 * retries=0 表示只试一次。
 */
export async function httpJsonRetry(
  opts: HttpJsonOpts,
  retries = 0,
  backoffMs = 1000,
): Promise<unknown> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      const { status, body } = await httpJson(opts);
      if (status >= 200 && status < 300) {
        return body ? JSON.parse(body) : null;
      }
      lastErr = new Error(`HTTP ${status}: ${body.slice(0, 200)}`);
    } catch (e) {
      lastErr = e;
    }
    if (i < retries) {
      await sleep(backoffMs * 2 ** i);
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export function envOrDie(name: string): string {
  const v = process.env[name];
  if (!v) {
    warn(`${name} not set — bootstrap aborted`);
    process.exit(1);
  }
  return v;
}
