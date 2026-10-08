import { describe, it, expect } from 'vitest';
import { validateNewPassword, MAX_PASSWORD_BYTES } from './password.js';

describe('validateNewPassword', () => {
  it('7 字符 → password_too_short', () => {
    expect(validateNewPassword('a'.repeat(7))).toBe('password_too_short');
  });
  it('8 字符 → 合法', () => {
    expect(validateNewPassword('a'.repeat(8))).toBeNull();
  });
  it('72 字节 → 合法, 73 字节 → password_too_long', () => {
    expect(validateNewPassword('a'.repeat(MAX_PASSWORD_BYTES))).toBeNull();
    expect(validateNewPassword('a'.repeat(MAX_PASSWORD_BYTES + 1))).toBe('password_too_long');
  });
  it('多字节按 UTF-8 字节算: 24 个汉字=72 字节合法, 25 个=75 字节超长', () => {
    expect(validateNewPassword('密'.repeat(24))).toBeNull();
    expect(validateNewPassword('密'.repeat(25))).toBe('password_too_long');
  });
  it('8 个汉字字符数够 8 → 合法(长度下限按字符数, 与现有注册一致)', () => {
    expect(validateNewPassword('密'.repeat(8))).toBeNull();
  });
});
