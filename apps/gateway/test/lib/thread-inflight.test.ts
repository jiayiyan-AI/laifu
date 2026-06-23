import { describe, it, expect, afterEach } from 'vitest';
import {
  tryReserveThread,
  releaseThread,
  isThreadReserved,
  __resetThreadInflightForTests,
} from '../../src/lib/thread-inflight.js';

afterEach(() => __resetThreadInflightForTests());

describe('thread-inflight', () => {
  it('reserve 成功后再 reserve 同 thread 被拒', () => {
    expect(tryReserveThread('t1')).toBe(true);
    expect(isThreadReserved('t1')).toBe(true);
    expect(tryReserveThread('t1')).toBe(false);
  });

  it('release 后可再 reserve', () => {
    expect(tryReserveThread('t1')).toBe(true);
    releaseThread('t1');
    expect(isThreadReserved('t1')).toBe(false);
    expect(tryReserveThread('t1')).toBe(true);
  });

  it('不同 thread 互不影响', () => {
    expect(tryReserveThread('a')).toBe(true);
    expect(tryReserveThread('b')).toBe(true);
    expect(isThreadReserved('a')).toBe(true);
    expect(isThreadReserved('b')).toBe(true);
    releaseThread('a');
    expect(isThreadReserved('a')).toBe(false);
    expect(isThreadReserved('b')).toBe(true);
  });

  it('release 幂等(重复 release 不抛)', () => {
    tryReserveThread('t1');
    releaseThread('t1');
    releaseThread('t1');
    expect(isThreadReserved('t1')).toBe(false);
  });
});
