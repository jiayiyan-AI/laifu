import { describe, it, expect, beforeEach } from 'vitest';
import { StreamRegistry } from '../../src/chat/stream-registry.js';

describe('StreamRegistry', () => {
  let reg: StreamRegistry;

  beforeEach(() => {
    reg = new StreamRegistry({ ttlMs: 60_000 });
  });

  it('register returns an outer stream_id matching shape', () => {
    const outer = reg.register({ containerUrl: 'http://localhost:8080', innerStreamId: 'inner_1' });
    expect(outer).toMatch(/^stm_/);
  });

  it('resolve returns the entry by outer id', () => {
    const outer = reg.register({ containerUrl: 'http://localhost:8080', innerStreamId: 'inner_1' });
    const entry = reg.resolve(outer);
    expect(entry).toEqual({ containerUrl: 'http://localhost:8080', innerStreamId: 'inner_1' });
  });

  it('resolve returns null for unknown id', () => {
    expect(reg.resolve('nope')).toBeNull();
  });

  it('expires entries past ttl', () => {
    const reg2 = new StreamRegistry({ ttlMs: 1 });
    const outer = reg2.register({ containerUrl: 'http://x', innerStreamId: 'y' });
    return new Promise((r) => setTimeout(r, 5)).then(() => {
      expect(reg2.resolve(outer)).toBeNull();
    });
  });

  it('release removes entry', () => {
    const outer = reg.register({ containerUrl: 'http://x', innerStreamId: 'y' });
    reg.release(outer);
    expect(reg.resolve(outer)).toBeNull();
  });
});
