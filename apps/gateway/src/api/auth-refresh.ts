import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { dao } from '../db/index.js';
import {
  signLaifuUserToken,
  verifyLaifuUserToken,
  TokenExpiredError,
  TokenInvalidError,
  TokenVersionMismatchError,
} from '../lib/gateway-token.js';
import type { RefreshTokenResponse } from '@lingxi/shared';

const GRACE_DAYS = 7;
const LIFETIME_SECONDS = 90 * 24 * 3600;

export interface AuthRefreshDeps {
  secret: string;
}

interface PeekedPayload {
  user_id: string;
  token_version: number;
}

function peekJwt(token: string): PeekedPayload {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('not a jwt');
  const raw = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  if (typeof raw.user_id !== 'string' || typeof raw.token_version !== 'number') {
    throw new Error('payload shape invalid');
  }
  return { user_id: raw.user_id, token_version: raw.token_version };
}

export const buildAuthRefreshRouter = (deps: AuthRefreshDeps): RouterType => {
  const router = Router();

  router.post('/api/auth/refresh-token', async (req: Request, res: Response) => {
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) {
      res.status(401).json({ error: 'missing or non-Bearer Authorization header' });
      return;
    }
    const token = header.slice(7);

    let userId: string;
    try {
      userId = peekJwt(token).user_id;
    } catch {
      res.status(401).json({ error: 'invalid token' });
      return;
    }

    let currentVersion: number | null;
    try {
      currentVersion = await dao.entitlements.getTokenVersion(userId);
    } catch (err) {
      console.error(`[auth-refresh] getTokenVersion threw for ${userId}:`, err);
      res.status(500).json({ error: 'internal' });
      return;
    }
    if (currentVersion === null) {
      res.status(401).json({ error: 'unknown user' });
      return;
    }

    try {
      verifyLaifuUserToken(token, {
        expectedTokenVersion: currentVersion,
        secret: deps.secret,
        allowExpiredWithinDays: GRACE_DAYS,
      });
    } catch (err) {
      if (err instanceof TokenVersionMismatchError) {
        res.status(401).json({ error: 'token revoked (version mismatch)' });
        return;
      }
      if (err instanceof TokenExpiredError) {
        res.status(401).json({ error: 'token expired beyond grace' });
        return;
      }
      if (err instanceof TokenInvalidError) {
        res.status(401).json({ error: 'invalid token' });
        return;
      }
      res.status(500).json({ error: 'internal' });
      return;
    }

    const newToken = signLaifuUserToken({
      userId,
      tokenVersion: currentVersion,
      secret: deps.secret,
    });
    const expiresAt = new Date((Math.floor(Date.now() / 1000) + LIFETIME_SECONDS) * 1000).toISOString();
    const body: RefreshTokenResponse = { token: newToken, expires_at: expiresAt };
    res.json(body);
  });

  return router;
};
