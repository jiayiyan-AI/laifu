import { describe, it, expect, vi } from 'vitest';
import type { UserDelegationKey } from '@azure/storage-blob';
import { UserDelegationKeyCache } from '../../src/lib/user-delegation-key-cache.js';

function fakeKey(expiresInSeconds: number): UserDelegationKey {
  const now = new Date();
  const expires = new Date(now.getTime() + expiresInSeconds * 1000);
  return {
    signedObjectId: 'fake-oid',
    signedTenantId: 'fake-tid',
    signedStartsOn: now.toISOString(),
    signedExpiresOn: expires.toISOString(),
    signedService: 'b',
    signedVersion: '2020-02-10',
    value: 'fake-udk-value',
  };
}

describe('UserDelegationKeyCache', () => {
  it('首次 get 调用 fetcher 并返回 key', async () => {
    const fetcher = vi.fn().mockResolvedValue(fakeKey(7 * 24 * 3600));
    const cache = new UserDelegationKeyCache({ fetcher, refreshWithinSeconds: 3600 });

    const key = await cache.get();
    expect(key.value).toBe('fake-udk-value');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('缓存有效期内复用，不再调 fetcher', async () => {
    const fetcher = vi.fn().mockResolvedValue(fakeKey(7 * 24 * 3600));
    const cache = new UserDelegationKeyCache({ fetcher, refreshWithinSeconds: 3600 });

    await cache.get();
    await cache.get();
    await cache.get();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('当 cached key 距过期 < refreshWithinSeconds 时刷新', async () => {
    // 第一次返回一个"剩余 30 分钟"的 key，第二次返回 7 天新的
    const firstKey = fakeKey(30 * 60);                 // 30min remaining
    const secondKey = fakeKey(7 * 24 * 3600);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(firstKey)
      .mockResolvedValueOnce(secondKey);

    const cache = new UserDelegationKeyCache({ fetcher, refreshWithinSeconds: 3600 }); // 1h window
    const k1 = await cache.get();
    expect(k1.signedExpiresOn).toBe(firstKey.signedExpiresOn);

    const k2 = await cache.get();
    // 30min < 1h 触发刷新，应拿到 second key
    expect(k2.signedExpiresOn).toBe(secondKey.signedExpiresOn);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('fetcher 抛错时 get 抛同样错，不污染缓存', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(fakeKey(7 * 24 * 3600));
    const cache = new UserDelegationKeyCache({ fetcher, refreshWithinSeconds: 3600 });

    await expect(cache.get()).rejects.toThrow('boom');
    // 再叫一次，应该重试 fetcher（缓存没污染）
    const k = await cache.get();
    expect(k.value).toBe('fake-udk-value');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('forceRefresh() 跳过缓存直接刷新', async () => {
    const k1 = fakeKey(7 * 24 * 3600);
    const k2 = fakeKey(7 * 24 * 3600);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(k1)
      .mockResolvedValueOnce(k2);

    const cache = new UserDelegationKeyCache({ fetcher, refreshWithinSeconds: 3600 });
    await cache.get();
    await cache.forceRefresh();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
