/**
 * OAuth token 加解密 — AES-256-GCM (Node 内置 crypto, 不引 libsodium)。
 *
 * 全 provider 共用一把 key: config.oauth.tokenEncryptionKey (32 字节 base64)。
 * 暂内置写死在 config.ts (用户决策 2026-06-25, 非 KV), env OAUTH_TOKEN_ENCRYPTION_KEY 可覆盖。
 * 落库格式: base64( iv(12) || authTag(16) || ciphertext )。详见 docs/todo/github.md §五。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../../config.js';

const IV_LEN = 12;
const TAG_LEN = 16;

const keyBuf = (): Buffer => {
  const k = Buffer.from(config.oauth.tokenEncryptionKey, 'base64');
  if (k.length !== 32) {
    throw new Error('OAUTH_TOKEN_ENCRYPTION_KEY must decode to 32 bytes');
  }
  return k;
};

export const encryptToken = (plaintext: string): string => {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', keyBuf(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
};

export const decryptToken = (encoded: string): string => {
  const buf = Buffer.from(encoded, 'base64');
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error('oauth encrypted token malformed');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', keyBuf(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
};

/** 加密 refresh token (可空)。无 refresh token 的 provider 直接存 null。 */
export const encryptOptional = (plaintext: string | null | undefined): string | null =>
  plaintext ? encryptToken(plaintext) : null;
