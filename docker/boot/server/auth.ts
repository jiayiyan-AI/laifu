// auth.ts — 容器侧 Bearer (LAIFU_USER_TOKEN / HS256 JWT) 校验。
//
// 容器运行时是 Bun 直接跑 .ts, **没有 node_modules** (jsonwebtoken 不可用),
// 所以这里用 node:crypto 手算 HMAC-SHA256 验签, 不依赖任何第三方库。
//
// 校验项 (gateway 出站 token 由 signLaifuUserToken 以 GATEWAY_SECRET 签):
//   1. header.alg === HS256 + 签名匹配 (timingSafeEqual)
//   2. 未过期 (exp)
//   3. user_id 与容器自身 LAIFU_USER_TOKEN 一致 (单租户容器, 拒绝跨用户 token)
//
// token_version 不强校: 撤销靠 gateway 侧 DB + 重启重签, 容器侧再校会引入
// "version bump 但容器未重启" 的瞬态拒绝, 相对今天 /chat 无校验是回归。本期目标是
// 阻断"扫到 container_url 就能调用", 验签已足够 (见 weichat-file-impl.md 风险 #5)。
//
// GATEWAY_SECRET 为空 (dev / 未注入) → requireBearer 放行, 保持本地开发零配置。

import { createHmac, timingSafeEqual } from 'node:crypto';
import { GATEWAY_SECRET, LAIFU_USER_TOKEN } from './config.ts';

interface JwtHeader {
  alg?: string;
}
export interface BearerClaims {
  user_id?: string;
  token_version?: number;
  iat?: number;
  exp?: number;
}

const decodeSegment = <T>(seg: string): T | null => {
  try {
    return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
};

/**
 * 纯函数验签 (无 env 依赖, 便于单测)。返回 claims 或 null。
 * expectedUserId 非空时还要求 claims.user_id 匹配。
 */
export function verifyBearer(
  token: string,
  secret: string,
  expectedUserId: string | null,
): BearerClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerSeg, payloadSeg, sigSeg] = parts;

  const header = decodeSegment<JwtHeader>(headerSeg!);
  if (!header || header.alg !== 'HS256') return null;

  const expected = createHmac('sha256', secret).update(`${headerSeg}.${payloadSeg}`).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(sigSeg!, 'base64url');
  } catch {
    return null;
  }
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  const claims = decodeSegment<BearerClaims>(payloadSeg!);
  if (!claims) return null;
  if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) return null;
  if (expectedUserId && claims.user_id !== expectedUserId) return null;
  return claims;
}

// 容器自身 token 的 user_id (我们自己签发的, 无需验签即可信任作为期望值)。
const ownUserId: string | null = (() => {
  if (!LAIFU_USER_TOKEN) return null;
  const parts = LAIFU_USER_TOKEN.split('.');
  if (parts.length !== 3) return null;
  return decodeSegment<BearerClaims>(parts[1]!)?.user_id ?? null;
})();

/**
 * 业务端点 Bearer 守卫 (HTTP seam)。通过返回 null (放行), 否则返回 401 Response。
 * GATEWAY_SECRET 未配置时直接放行 (dev)。
 */
export function requireBearer(req: Request): Response | null {
  if (!GATEWAY_SECRET) return null; // dev / 未注入 secret: 不强制
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const claims = verifyBearer(auth.slice(7), GATEWAY_SECRET, ownUserId);
  if (!claims) return Response.json({ error: 'unauthorized' }, { status: 401 });
  return null;
}
