import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes } from 'node:crypto';

// crypto.ts 经 config 单例读 OAUTH_TOKEN_ENCRYPTION_KEY，须在 import 前设好 env，
// 故用动态 import (config 在该 import 时才求值)。
const KEY = randomBytes(32).toString('base64');

describe('oauth token crypto (AES-256-GCM)', () => {
  let encryptToken: (s: string) => string;
  let decryptToken: (s: string) => string;

  beforeAll(async () => {
    process.env['OAUTH_TOKEN_ENCRYPTION_KEY'] = KEY;
    const mod = await import('../../../src/integrations/oauth/crypto.js');
    encryptToken = mod.encryptToken;
    decryptToken = mod.decryptToken;
  });

  it('round-trips a token through encrypt → decrypt', () => {
    const plain = 'gho_' + randomBytes(20).toString('hex');
    expect(decryptToken(encryptToken(plain))).toBe(plain);
  });

  it('round-trips empty string and unicode', () => {
    expect(decryptToken(encryptToken(''))).toBe('');
    const u = '令牌-🔑-test';
    expect(decryptToken(encryptToken(u))).toBe(u);
  });

  it('ciphertext is not the plaintext and is base64', () => {
    const plain = 'gho_secret_value';
    const enc = encryptToken(plain);
    expect(enc).not.toContain(plain);
    expect(enc).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('same plaintext encrypts to different ciphertext (random IV)', () => {
    const plain = 'gho_same_input';
    expect(encryptToken(plain)).not.toBe(encryptToken(plain));
  });

  it('throws on tampered ciphertext (GCM auth tag mismatch)', () => {
    const enc = encryptToken('gho_tamper_me');
    const buf = Buffer.from(enc, 'base64');
    buf[buf.length - 1] ^= 0xff; // 翻转最后一字节
    expect(() => decryptToken(buf.toString('base64'))).toThrow();
  });

  it('throws on truncated/malformed input', () => {
    expect(() => decryptToken('AAAA')).toThrow();
  });
});
