import { describe, it, expect } from 'vitest';
import { signSession, verifySession, sessionCookieOpts, type SessionPayload } from '../../src/auth/session.js';

const SECRET = 'test-secret-do-not-use-in-prod-123456';

describe('session JWT', () => {
  const payload: SessionPayload = { user_id: 'u1' };

  it('signs and verifies a round-trip', () => {
    const token = signSession(payload, SECRET, 24);
    const decoded = verifySession(token, SECRET);
    expect(decoded.user_id).toBe('u1');
  });

  it('throws on wrong secret', () => {
    const token = signSession(payload, SECRET, 24);
    expect(() => verifySession(token, 'wrong-secret-xxx')).toThrow();
  });

  it('throws on expired token', () => {
    const token = signSession(payload, SECRET, -1); // already expired
    expect(() => verifySession(token, SECRET)).toThrow();
  });

  it('sessionCookieOpts produces httpOnly cookies', () => {
    const opts = sessionCookieOpts(168);
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('lax');
    expect(opts.maxAge).toBe(168 * 3600 * 1000);
  });
});
