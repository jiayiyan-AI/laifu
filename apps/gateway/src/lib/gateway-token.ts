import jwt from 'jsonwebtoken';

const TOKEN_LIFETIME_SECONDS = 90 * 24 * 3600;   // 90d
const ALGORITHM: jwt.Algorithm = 'HS256';

export class TokenInvalidError extends Error {
  constructor(message = 'invalid token') {
    super(message);
    this.name = 'TokenInvalidError';
  }
}

export class TokenExpiredError extends Error {
  constructor(message = 'token expired') {
    super(message);
    this.name = 'TokenExpiredError';
  }
}

export class TokenVersionMismatchError extends Error {
  constructor(message = 'token_version mismatch (token revoked)') {
    super(message);
    this.name = 'TokenVersionMismatchError';
  }
}

export interface SignInput {
  userId: string;
  tokenVersion: number;
  secret: string;
}

export interface VerifyInput {
  expectedTokenVersion: number;
  secret: string;
  /**
   * If set, accept tokens that expired up to this many days ago.
   * Used by /api/auth/refresh-token to let a container that slept past
   * exp still get a new token (within grace).
   */
  allowExpiredWithinDays?: number;
}

export interface DecodedPayload {
  userId: string;
  tokenVersion: number;
  iat: number;
  exp: number;
}

interface JwtPayload {
  user_id: string;
  token_version: number;
  iat: number;
  exp: number;
}

export function signLaifuUserToken(input: SignInput): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: JwtPayload = {
    user_id: input.userId,
    token_version: input.tokenVersion,
    iat: now,
    exp: now + TOKEN_LIFETIME_SECONDS,
  };
  // We control iat/exp ourselves (jsonwebtoken's `expiresIn` would also work, but
  // explicit control is clearer for tests + the grace logic below).
  // Note: omit noTimestamp so jsonwebtoken preserves our explicit iat field in the token.
  return jwt.sign(payload, input.secret, { algorithm: ALGORITHM });
}

/**
 * 同 `signLaifuUserToken`，额外把签发时算出的 `exp` 转成 ISO-8601 一并返回。
 *
 * 背景：`device-token.ts` / `auth-refresh.ts` 原先各自用本地常量重算一遍
 * "now + 90d" 作为响应里的 `expires_at`——跟 JWT 内真正的 `exp` 是两份独立计算，
 * 值碰巧相同全靠两处常量手动保持一致，一旦某处改动就会让响应字段撒谎。
 * 这里直接从签发时的同一个 `exp` 派生，消除该重复。
 */
export function signLaifuUserTokenWithExpiry(input: SignInput): { token: string; expiresAt: string } {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + TOKEN_LIFETIME_SECONDS;
  const payload: JwtPayload = {
    user_id: input.userId,
    token_version: input.tokenVersion,
    iat: now,
    exp,
  };
  const token = jwt.sign(payload, input.secret, { algorithm: ALGORITHM });
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

export function verifyLaifuUserToken(token: string, input: VerifyInput): DecodedPayload {
  // Step 1: signature + structural verification with skew tolerance for grace.
  // `ignoreExpiration: true` skips JWT's built-in exp check; we do it ourselves below
  // so grace mode can accept short-expired tokens.
  let raw: JwtPayload;
  try {
    raw = jwt.verify(token, input.secret, {
      algorithms: [ALGORITHM],
      ignoreExpiration: true,
    }) as JwtPayload;
  } catch (err) {
    throw new TokenInvalidError(err instanceof Error ? err.message : 'invalid token');
  }

  // Step 2: shape validation
  if (typeof raw.user_id !== 'string' || typeof raw.token_version !== 'number'
      || typeof raw.iat !== 'number' || typeof raw.exp !== 'number') {
    throw new TokenInvalidError('payload shape invalid');
  }

  // Step 3: token_version check
  if (raw.token_version !== input.expectedTokenVersion) {
    throw new TokenVersionMismatchError(
      `expected token_version ${input.expectedTokenVersion}, got ${raw.token_version}`,
    );
  }

  // Step 4: expiration check (with optional grace)
  const now = Math.floor(Date.now() / 1000);
  const graceSec = (input.allowExpiredWithinDays ?? 0) * 24 * 3600;
  if (raw.exp + graceSec < now) {
    throw new TokenExpiredError(
      `token expired at ${new Date(raw.exp * 1000).toISOString()}`,
    );
  }

  return {
    userId: raw.user_id,
    tokenVersion: raw.token_version,
    iat: raw.iat,
    exp: raw.exp,
  };
}
