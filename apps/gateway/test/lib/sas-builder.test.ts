import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import type { UserDelegationKey } from '@azure/storage-blob';
import { buildDirectoryWriteSas } from '../../src/lib/sas-builder.js';

const ACCOUNT = 'laifudev';
const CONTAINER = 'laifu-cloud';
const USER_ID = '6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f';

function fakeUdk(): UserDelegationKey {
  const now = new Date();
  const expires = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
  return {
    signedObjectId: '00000000-0000-0000-0000-000000000001',
    signedTenantId: '00000000-0000-0000-0000-000000000002',
    signedStartsOn: now.toISOString(),
    signedExpiresOn: expires.toISOString(),
    signedService: 'b',
    signedVersion: '2020-02-10',
    // 32 字节 base64 UDK 值；签名时只需是 valid base64 即可，内容随便
    value: Buffer.from('a'.repeat(32)).toString('base64'),
  };
}

function parseSas(token: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of token.split('&')) {
    const [k, v] = part.split('=', 2);
    if (k) out[k] = decodeURIComponent(v ?? '');
  }
  return out;
}

describe('buildDirectoryWriteSas', () => {
  it('生成的 SAS 是 directory-scoped (sr=d, sdd=1)', () => {
    const { sasToken } = buildDirectoryWriteSas({
      account: ACCOUNT,
      container: CONTAINER,
      userId: USER_ID,
      udk: fakeUdk(),
      ttlSeconds: 900,
    });

    const params = parseSas(sasToken);
    expect(params['sr']).toBe('d');
    expect(params['sdd']).toBe('1');
  });

  it('signedVersion >= 2020-02-10', () => {
    const { sasToken } = buildDirectoryWriteSas({
      account: ACCOUNT,
      container: CONTAINER,
      userId: USER_ID,
      udk: fakeUdk(),
      ttlSeconds: 900,
    });

    const params = parseSas(sasToken);
    expect(params['sv']).toBeDefined();
    expect(params['sv']! >= '2020-02-10').toBe(true);
  });

  it('权限 racwl 全集', () => {
    const { sasToken } = buildDirectoryWriteSas({
      account: ACCOUNT,
      container: CONTAINER,
      userId: USER_ID,
      udk: fakeUdk(),
      ttlSeconds: 900,
    });

    const params = parseSas(sasToken);
    // sp 字段顺序由 SDK 决定，按字符集合比较
    const perms = new Set(params['sp']!.split(''));
    expect(perms.has('r')).toBe(true);
    expect(perms.has('a')).toBe(true);
    expect(perms.has('c')).toBe(true);
    expect(perms.has('w')).toBe(true);
    expect(perms.has('l')).toBe(true);
  });

  it('强制 HTTPS only (spr=https)', () => {
    const { sasToken } = buildDirectoryWriteSas({
      account: ACCOUNT,
      container: CONTAINER,
      userId: USER_ID,
      udk: fakeUdk(),
      ttlSeconds: 900,
    });

    const params = parseSas(sasToken);
    expect(params['spr']).toBe('https');
  });

  it('expiresAt 大致是 now + ttlSeconds', () => {
    const before = Date.now();
    const { expiresAt } = buildDirectoryWriteSas({
      account: ACCOUNT,
      container: CONTAINER,
      userId: USER_ID,
      udk: fakeUdk(),
      ttlSeconds: 900,
    });
    const after = Date.now();
    const expiresMs = expiresAt.getTime();
    // 允许 ±5s 误差
    expect(expiresMs).toBeGreaterThanOrEqual(before + 900_000 - 5000);
    expect(expiresMs).toBeLessThanOrEqual(after + 900_000 + 5000);
  });

  it('返回 prefix 以 user_id/ 结尾', () => {
    const { prefix } = buildDirectoryWriteSas({
      account: ACCOUNT,
      container: CONTAINER,
      userId: USER_ID,
      udk: fakeUdk(),
      ttlSeconds: 900,
    });
    expect(prefix).toBe(`${USER_ID}/`);
  });

  it('sas token 含 sig', () => {
    const { sasToken } = buildDirectoryWriteSas({
      account: ACCOUNT,
      container: CONTAINER,
      userId: USER_ID,
      udk: fakeUdk(),
      ttlSeconds: 900,
    });
    const params = parseSas(sasToken);
    expect(params['sig']).toBeDefined();
    expect(params['sig']!.length).toBeGreaterThan(20);
  });

  // 自洽 round-trip：用 SAS token 里的 st/se/skt/ske/sp/sv/sr 等字段反推 string-to-sign，
  // 用同一份 UDK value 重新 HMAC-SHA256 一遍，必须和 token 里的 sig 完全一致。
  // 这能保证 (1) 槽位顺序对得上 spec；(2) 没有在签名后再做破坏性 mutation。
  it('round-trip：本地按同样的 string-to-sign 重算 HMAC，sig 必须一致', () => {
    const udk = fakeUdk();
    const { sasToken } = buildDirectoryWriteSas({
      account: ACCOUNT,
      container: CONTAINER,
      userId: USER_ID,
      udk,
      ttlSeconds: 900,
    });
    const params = parseSas(sasToken);

    // 从 token 里读回 builder 实际用的时间字符串，避免重新生成时漂移。
    const stringToSign = [
      params['sp']!,                                              //  1. signedPermissions
      params['st']!,                                              //  2. signedStart
      params['se']!,                                              //  3. signedExpiry
      `/blob/${ACCOUNT}/${CONTAINER}/${USER_ID}`,                 //  4. canonicalizedResource (无尾随 /)
      params['skoid']!,                                           //  5. signedKeyObjectId
      params['sktid']!,                                           //  6. signedKeyTenantId
      params['skt']!,                                             //  7. signedKeyStart
      params['ske']!,                                             //  8. signedKeyExpiry
      params['sks']!,                                             //  9. signedKeyService
      params['skv']!,                                             // 10. signedKeyVersion
      '',                                                         // 11. preauthorizedAgentObjectId
      '',                                                         // 12. agentObjectId
      '',                                                         // 13. signedCorrelationId
      '',                                                         // 14. signedIP
      params['spr']!,                                             // 15. signedProtocol
      params['sv']!,                                              // 16. signedVersion
      params['sr']!,                                              // 17. signedResource
      '',                                                         // 18. signedTimestamp
      '',                                                         // 19. rscc
      '',                                                         // 20. rscd
      '',                                                         // 21. rsce
      '',                                                         // 22. rscl
      '',                                                         // 23. rsct
    ].join('\n');

    const expected = createHmac('sha256', Buffer.from(udk.value, 'base64'))
      .update(stringToSign, 'utf8')
      .digest('base64');

    expect(params['sig']).toBe(expected);
    // 防御性断言：22 个 '\n' = 23 个字段
    expect((stringToSign.match(/\n/g) ?? []).length).toBe(22);
  });

  describe('input validation', () => {
    const validUdk = fakeUdk();
    const validInput = {
      account: ACCOUNT,
      container: CONTAINER,
      userId: USER_ID,
      udk: validUdk,
      ttlSeconds: 900,
    };

    it('reject userId with newline (string-to-sign injection)', () => {
      expect(() => buildDirectoryWriteSas({ ...validInput, userId: 'aaaa\nbbbb' })).toThrow(/userId/);
    });

    it('reject userId with slash (path injection)', () => {
      expect(() => buildDirectoryWriteSas({ ...validInput, userId: 'other/uuid' })).toThrow(/userId/);
    });

    it('reject userId that is not a UUID', () => {
      expect(() => buildDirectoryWriteSas({ ...validInput, userId: 'not-a-uuid' })).toThrow(/userId/);
    });

    it('reject empty userId', () => {
      expect(() => buildDirectoryWriteSas({ ...validInput, userId: '' })).toThrow(/userId/);
    });

    it('reject invalid account name (uppercase)', () => {
      expect(() => buildDirectoryWriteSas({ ...validInput, account: 'BadAccount' })).toThrow(/account/);
    });

    it('reject invalid account name (too short)', () => {
      expect(() => buildDirectoryWriteSas({ ...validInput, account: 'ab' })).toThrow(/account/);
    });

    it('reject invalid container name (uppercase)', () => {
      expect(() => buildDirectoryWriteSas({ ...validInput, container: 'BadName' })).toThrow(/container/);
    });

    it('reject invalid container name (starts with -)', () => {
      expect(() => buildDirectoryWriteSas({ ...validInput, container: '-foo' })).toThrow(/container/);
    });
  });
});
