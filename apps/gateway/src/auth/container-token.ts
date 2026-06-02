import type { Request, Response, NextFunction, RequestHandler } from 'express';
import {
  verifyLaifuUserToken,
  TokenInvalidError,
  TokenExpiredError,
  TokenVersionMismatchError,
} from '../lib/gateway-token.js';

export interface ContainerTokenMiddlewareOptions {
  secret: string;
  /**
   * 查给定 userId 当前的 users.token_version；返回 null 表示用户不存在
   * (DAO 会做这个查询；测试里 mock)。
   */
  tokenVersionFetcher: (userId: string) => Promise<number | null>;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user_id?: string;
    }
  }
}

export const makeContainerTokenMiddleware = (
  opts: ContainerTokenMiddlewareOptions,
): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) {
      res.status(401).json({ error: 'missing or non-Bearer Authorization header' });
      return;
    }
    const token = header.slice(7);

    let userId: string;
    try {
      const peeked = peekJwtPayload(token);
      userId = peeked.user_id;
    } catch (err) {
      res.status(401).json({ error: 'invalid token' });
      return;
    }

    let currentVersion: number | null;
    try {
      currentVersion = await opts.tokenVersionFetcher(userId);
    } catch (err) {
      console.error(`[container-token] tokenVersionFetcher threw for user ${userId}:`, err);
      res.status(500).json({ error: 'internal' });
      return;
    }
    if (currentVersion === null) {
      res.status(401).json({ error: 'unknown user' });
      return;
    }

    try {
      const payload = verifyLaifuUserToken(token, {
        expectedTokenVersion: currentVersion,
        secret: opts.secret,
      });
      req.user_id = payload.userId;
      next();
    } catch (err) {
      if (err instanceof TokenVersionMismatchError) {
        res.status(401).json({ error: 'token revoked (version mismatch)' });
        return;
      }
      if (err instanceof TokenExpiredError) {
        res.status(401).json({ error: 'token expired' });
        return;
      }
      if (err instanceof TokenInvalidError) {
        res.status(401).json({ error: 'invalid token' });
        return;
      }
      res.status(500).json({ error: 'internal' });
    }
  };
};

/**
 * Peek at a JWT payload without verifying signature — used only to extract user_id
 * before we can know which DB row to query for the expected token_version. The actual
 * security check happens in verifyLaifuUserToken below.
 */
interface PeekedPayload {
  user_id: string;
  token_version: number;
}
function peekJwtPayload(token: string): PeekedPayload {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('not a jwt');
  const payloadJson = Buffer.from(parts[1]!, 'base64url').toString('utf8');
  const raw = JSON.parse(payloadJson);
  if (typeof raw.user_id !== 'string' || typeof raw.token_version !== 'number') {
    throw new Error('payload shape invalid');
  }
  return { user_id: raw.user_id, token_version: raw.token_version };
}
