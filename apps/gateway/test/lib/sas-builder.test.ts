import { describe, it, expect } from 'vitest';
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
});
