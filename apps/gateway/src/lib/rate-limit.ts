/**
 * 进程内固定窗口限流。单实例 B1 部署够用, 不引 Redis; 多实例时需换共享存储。
 * hit() 放行才计数, 被拒不计数。
 */
import type { Request } from 'express';

export interface RateLimiter {
  hit(key: string, limit: number, windowMs: number): boolean;
  reset(): void;
}

export const makeRateLimiter = (opts: { now?: () => number } = {}): RateLimiter => {
  const now = opts.now ?? Date.now;
  const buckets = new Map<string, { count: number; resetAt: number }>();
  let lastSweep = now();
  const sweep = (t: number) => {
    if (t - lastSweep < 60_000) return;
    lastSweep = t;
    for (const [k, b] of buckets) if (b.resetAt <= t) buckets.delete(k);
  };
  return {
    hit(key, limit, windowMs) {
      const t = now();
      sweep(t);
      const b = buckets.get(key);
      if (!b || b.resetAt <= t) {
        buckets.set(key, { count: 1, resetAt: t + windowMs });
        return true;
      }
      if (b.count >= limit) return false;
      b.count += 1;
      return true;
    },
    reset() {
      buckets.clear();
    },
  };
};

/** 认证类接口(找回 / 重置 / 修改密码)共用的限流器。 */
export const authRateLimiter: RateLimiter = makeRateLimiter();

/**
 * 取客户端 IP 作限流 key。Azure App Service 会把 `ip:port` 写进 X-Forwarded-For,
 * 直接用 req.ip 会让每条 TCP 连接各占一个桶(绕过限流), 所以这里剥掉端口:
 *   `[v6]:port` -> v6; `a.b.c.d:port` -> a.b.c.d; 裸 IPv6(多个冒号)原样返回。
 */
export const clientIp = (req: Request): string => {
  const raw = req.ip ?? '';
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(raw);
  if (bracket) return bracket[1]!;
  const v4 = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(raw);
  if (v4) return v4[1]!;
  return raw;
};
