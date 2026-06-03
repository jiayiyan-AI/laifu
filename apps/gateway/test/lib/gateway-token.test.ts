import { describe, it, expect, vi } from 'vitest';
import {
  signLaifuUserToken,
  verifyLaifuUserToken,
  TokenExpiredError,
  TokenVersionMismatchError,
  TokenInvalidError,
} from '../../src/lib/gateway-token.js';

const SECRET = 'test-secret-1234567890';
const USER_ID = '6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f';

describe('gateway-token', () => {
  describe('sign + verify happy path', () => {
    it('round-trips userId and tokenVersion', () => {
      const token = signLaifuUserToken({ userId: USER_ID, tokenVersion: 3, secret: SECRET });
      const payload = verifyLaifuUserToken(token, { expectedTokenVersion: 3, secret: SECRET });
      expect(payload.userId).toBe(USER_ID);
      expect(payload.tokenVersion).toBe(3);
      expect(payload.exp - payload.iat).toBe(90 * 24 * 3600);
    });

    it('exp is 90 days from now', () => {
      const before = Math.floor(Date.now() / 1000);
      const token = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: SECRET });
      const after = Math.floor(Date.now() / 1000);
      const payload = verifyLaifuUserToken(token, { expectedTokenVersion: 0, secret: SECRET });
      expect(payload.exp).toBeGreaterThanOrEqual(before + 90 * 24 * 3600);
      expect(payload.exp).toBeLessThanOrEqual(after + 90 * 24 * 3600);
    });
  });

  describe('verification failures', () => {
    it('throws TokenVersionMismatchError when versions differ', () => {
      const token = signLaifuUserToken({ userId: USER_ID, tokenVersion: 1, secret: SECRET });
      expect(() =>
        verifyLaifuUserToken(token, { expectedTokenVersion: 2, secret: SECRET }),
      ).toThrow(TokenVersionMismatchError);
    });

    it('throws TokenInvalidError on tampered signature', () => {
      const token = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: SECRET });
      const tampered = token.slice(0, -4) + 'AAAA';
      expect(() =>
        verifyLaifuUserToken(tampered, { expectedTokenVersion: 0, secret: SECRET }),
      ).toThrow(TokenInvalidError);
    });

    it('throws TokenInvalidError on wrong secret', () => {
      const token = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: SECRET });
      expect(() =>
        verifyLaifuUserToken(token, { expectedTokenVersion: 0, secret: 'wrong-secret' }),
      ).toThrow(TokenInvalidError);
    });

    it('throws TokenExpiredError on expired token', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const token = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: SECRET });
      vi.setSystemTime(new Date('2026-04-15T00:00:00Z')); // 104 days later
      expect(() =>
        verifyLaifuUserToken(token, { expectedTokenVersion: 0, secret: SECRET }),
      ).toThrow(TokenExpiredError);
      vi.useRealTimers();
    });
  });

  describe('grace mode (for refresh-token)', () => {
    it('verifyLaifuUserToken with allowExpiredWithinDays=7 accepts a 5-day-expired token', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const token = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: SECRET });
      vi.setSystemTime(new Date('2026-04-06T00:00:00Z')); // 95 days later: token expired 5d ago
      const payload = verifyLaifuUserToken(token, {
        expectedTokenVersion: 0,
        secret: SECRET,
        allowExpiredWithinDays: 7,
      });
      expect(payload.userId).toBe(USER_ID);
      vi.useRealTimers();
    });

    it('verifyLaifuUserToken with allowExpiredWithinDays=7 rejects an 8-day-expired token', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const token = signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: SECRET });
      vi.setSystemTime(new Date('2026-04-09T00:00:00Z')); // 98 days later: token expired 8d ago
      expect(() =>
        verifyLaifuUserToken(token, {
          expectedTokenVersion: 0,
          secret: SECRET,
          allowExpiredWithinDays: 7,
        }),
      ).toThrow(TokenExpiredError);
      vi.useRealTimers();
    });
  });
});
