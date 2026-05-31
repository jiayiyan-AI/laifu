import type { OAuthProvider } from './types.js';
import { makeGoogleProvider } from './google.js';
import { config } from '../../config.js';

/**
 * Registry of enabled OAuth providers.
 *
 * 加新 provider:
 *   1. 在 ./<name>.ts 实现 OAuthProvider 接口
 *   2. 在这里加一个 if (config.auth.providers.<name>?.clientId) providers.<name> = ...
 *   3. config.ts 加对应 env 字段
 *   4. .env(.example) 加对应 env 占位
 *
 * 一个 provider 只要 clientId 没填,自动从 registry 里缺席 ——
 * oauth-router 会对该 provider 路径返 404,前端 LoginPage 也不显示按钮。
 */
export const providers: Record<string, OAuthProvider> = {};

if (config.auth.providers.google?.clientId && config.auth.providers.google?.clientSecret) {
  providers.google = makeGoogleProvider({
    clientId: config.auth.providers.google.clientId,
    clientSecret: config.auth.providers.google.clientSecret,
  });
}

export type { OAuthProvider, NormalizedUser } from './types.js';
