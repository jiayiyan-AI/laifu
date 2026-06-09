// 共享工具: HTTPS 请求 / 读 token / 日志。零三方依赖, 只用 Node 标准库。
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { URL } from 'node:url';

export const HOME_DIR = '/home/hermes';
export const TOKEN_FILE = `${HOME_DIR}/.hermes/.laifu_user_token`;

export function log(msg) {
  console.log(`[bootstrap] ${msg}`);
}
export function warn(msg) {
  console.error(`[bootstrap] WARN: ${msg}`);
}

/**
 * 读 LAIFU_USER_TOKEN: 先 env, 再 fallback token 文件 (持久化在 home volume)。
 * Fallback 场景: dev 模式 docker restart 时 env 没新值; 或 prod 容器自然重启。
 */
export function readToken() {
  const fromEnv = process.env['LAIFU_USER_TOKEN'];
  if (fromEnv) return fromEnv;
  if (existsSync(TOKEN_FILE)) {
    return readFileSync(TOKEN_FILE, 'utf8').trim();
  }
  return '';
}

export function writeToken(token) {
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
}

/** base64url decode (Node 原生支持, 不需要换 chars) */
export function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('not a jwt');
  const json = Buffer.from(parts[1], 'base64url').toString('utf8');
  return JSON.parse(json);
}

/**
 * 简单 HTTP(S) 请求 helper, 仿 fetch 接口但走标准库。
 * 默认 10s timeout。返回 { status, body } (body 是 string)。
 * 不做 redirect, 不做 retry — 调用方按需自己包。
 */
export function httpJson({ method, url, headers, body, timeoutMs = 10_000 }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const fn = isHttps ? httpsRequest : httpRequest;
    const bodyStr = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const req = fn(
      {
        method,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        headers: {
          'Content-Length': Buffer.byteLength(bodyStr),
          ...(body && typeof body !== 'string' ? { 'Content-Type': 'application/json' } : {}),
          ...(headers || {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let chunks = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (chunks += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: chunks }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`request timeout after ${timeoutMs}ms`));
    });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * httpJson + 解析 JSON body, 兼带简单 retry (exp backoff)。
 * retries=0 表示只试一次。
 */
export async function httpJsonRetry(opts, retries = 0, backoffMs = 1000) {
  let lastErr;
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
      await new Promise((r) => setTimeout(r, backoffMs * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

export function envOrDie(name) {
  const v = process.env[name];
  if (!v) {
    warn(`${name} not set — bootstrap aborted`);
    process.exit(1);
  }
  return v;
}
