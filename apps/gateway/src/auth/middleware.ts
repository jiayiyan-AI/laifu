import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { verifySession, type SessionPayload } from './session.js';
import type { SessionVersionStore } from './session-version.js';

export interface RequireSessionOpts {
  secret: string;
  cookieName: string;
  /** 传了就比对 users.session_version(改密码后旧会话失效)。生产装配必须传。 */
  versions?: SessionVersionStore;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: SessionPayload;
    }
  }
}

export const requireSession = (opts: RequireSessionOpts): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
    const token = cookies[opts.cookieName];
    if (!token) {
      res.status(401).json({ error: 'not authenticated' });
      return;
    }
    let payload: SessionPayload;
    try {
      payload = verifySession(token, opts.secret);
    } catch {
      res.status(401).json({ error: 'invalid session' });
      return;
    }
    if (opts.versions) {
      let current: number | null;
      try {
        current = await opts.versions.get(payload.user_id);
      } catch (err) {
        // fail-open: DB 抖动时不让全站 401; 代价是这一刻吊销不生效。
        console.error(`[requireSession] session_version 查询失败, 放行 user=${payload.user_id}:`, err);
        req.session = payload;
        next();
        return;
      }
      if (current === null) {
        res.status(401).json({ error: 'user not found' });
        return;
      }
      if ((payload.sv ?? 0) !== current) {
        console.warn(`[requireSession] auth.session.revoked user=${payload.user_id} sv=${payload.sv ?? 0} current=${current}`);
        res.status(401).json({ error: 'session revoked' });
        return;
      }
    }
    req.session = payload;
    next();
  };
};
