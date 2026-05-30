import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { verifySession, type SessionPayload } from './session.js';

export interface RequireSessionOpts {
  secret: string;
  cookieName: string;
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
  return (req: Request, res: Response, next: NextFunction): void => {
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
    const token = cookies[opts.cookieName];
    if (!token) {
      res.status(401).json({ error: 'not authenticated' });
      return;
    }
    try {
      req.session = verifySession(token, opts.secret);
      next();
    } catch {
      res.status(401).json({ error: 'invalid session' });
    }
  };
};
