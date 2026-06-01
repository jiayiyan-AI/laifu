import type { UserDelegationKey } from '@azure/storage-blob';

export interface UserDelegationKeyCacheOptions {
  /**
   * 拉取新 UDK 的函数。生产里用 BlobServiceClient.getUserDelegationKey(start, expiry)。
   * 测试里传 stub。
   */
  fetcher: () => Promise<UserDelegationKey>;

  /**
   * 当 cached key 距 signedExpiresOn < 此秒数时，下次 get() 会触发刷新。
   * spec 推荐 3600s（提前 1 小时刷新，UDK 自身 7d TTL）。
   */
  refreshWithinSeconds: number;
}

/**
 * 缓存 Azure User Delegation Key，避免每次签 SAS 都打 Azure。
 *
 * UDK 自身有 TTL（上限 7 天），cache 里只存最近一次拉到的 key，
 * 在剩余时间窗内复用，临近过期时透明刷新。
 *
 * 不持久化 —— gateway 重启后会重新拉。
 *
 * 单实例非线程安全（Node.js 是 single-threaded，无所谓）。但并发请求
 * 都会触发刷新时，多个 fetcher 调用会被并发发起 —— 接受这点，
 * Azure 服务端拿同样 UDK 不算重复。如果将来要避免，加 Promise dedupe。
 */
export class UserDelegationKeyCache {
  private cached: UserDelegationKey | null = null;
  private readonly fetcher: () => Promise<UserDelegationKey>;
  private readonly refreshWithinMs: number;

  constructor(opts: UserDelegationKeyCacheOptions) {
    this.fetcher = opts.fetcher;
    this.refreshWithinMs = opts.refreshWithinSeconds * 1000;
  }

  async get(): Promise<UserDelegationKey> {
    if (this.cached && !this.isExpiringSoon(this.cached)) {
      return this.cached;
    }
    return this.refresh();
  }

  async forceRefresh(): Promise<UserDelegationKey> {
    return this.refresh();
  }

  private async refresh(): Promise<UserDelegationKey> {
    // 不预先清空 cached：若 fetcher 抛错，下次 get 还可以触发重试，但不污染之前的 cache。
    // 这里特意把"赋值"放在 await 之后，确保抛错时 cached 不被覆盖。
    const fresh = await this.fetcher();
    this.cached = fresh;
    return fresh;
  }

  private isExpiringSoon(key: UserDelegationKey): boolean {
    const expiresAt = new Date(key.signedExpiresOn).getTime();
    return expiresAt - Date.now() < this.refreshWithinMs;
  }
}
