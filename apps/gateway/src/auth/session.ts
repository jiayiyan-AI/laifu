import jwt from 'jsonwebtoken';

export interface SessionPayload {
  user_id: string;
}

export const signSession = (payload: SessionPayload, secret: string, ttlHours: number): string => {
  return jwt.sign(payload, secret, {
    algorithm: 'HS256',
    expiresIn: `${ttlHours}h`,
  });
};

export const verifySession = (token: string, secret: string): SessionPayload => {
  const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
  if (typeof decoded !== 'object' || decoded === null || typeof (decoded as { user_id?: unknown }).user_id !== 'string') {
    throw new Error('invalid session payload shape');
  }
  return { user_id: (decoded as { user_id: string }).user_id };
};

export interface CookieOpts {
  httpOnly: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  secure: boolean;
  maxAge: number;
  path: string;
}

export const sessionCookieOpts = (ttlHours: number): CookieOpts => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env['NODE_ENV'] === 'production',
  maxAge: ttlHours * 3600 * 1000,
  path: '/',
});
