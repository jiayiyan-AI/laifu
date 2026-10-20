import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { makeRateLimiter, clientIp } from '../../src/lib/rate-limit.js';

describe('makeRateLimiter', () => {
  it('窗口内超过 limit 拒绝, 窗口过后恢复', () => {
    let t = 0;
    const rl = makeRateLimiter({ now: () => t });
    expect(rl.hit('k', 2, 1000)).toBe(true);
    expect(rl.hit('k', 2, 1000)).toBe(true);
    expect(rl.hit('k', 2, 1000)).toBe(false);
    t = 1000;
    expect(rl.hit('k', 2, 1000)).toBe(true);
  });

  it('不同 key 互不影响', () => {
    const rl = makeRateLimiter({ now: () => 0 });
    expect(rl.hit('a', 1, 1000)).toBe(true);
    expect(rl.hit('b', 1, 1000)).toBe(true);
    expect(rl.hit('a', 1, 1000)).toBe(false);
  });

  it('同一 key 可叠加不同窗口(用 key 后缀区分)', () => {
    let t = 0;
    const rl = makeRateLimiter({ now: () => t });
    // 60s 1 次 + 1h 5 次
    const allow = () => rl.hit('e:1m', 1, 60_000) && rl.hit('e:1h', 5, 3_600_000);
    expect(allow()).toBe(true);
    expect(allow()).toBe(false);
    for (let i = 1; i < 5; i++) { t = i * 61_000; expect(allow()).toBe(true); }
    t = 5 * 61_000;
    expect(allow()).toBe(false); // 1h 内第 6 次
  });
});

describe('clientIp', () => {
  const ip = (v: string | undefined) => clientIp({ ip: v } as Request);
  it('去掉 Azure XFF 带的端口', () => {
    expect(ip('1.2.3.4:51234')).toBe('1.2.3.4');
    expect(ip('[2001:db8::1]:443')).toBe('2001:db8::1');
  });
  it('无端口原样返回', () => {
    expect(ip('1.2.3.4')).toBe('1.2.3.4');
    expect(ip('2001:db8::1')).toBe('2001:db8::1');
    expect(ip('::ffff:1.2.3.4')).toBe('::ffff:1.2.3.4');
  });
  it('undefined → 空串', () => {
    expect(ip(undefined)).toBe('');
  });
});
