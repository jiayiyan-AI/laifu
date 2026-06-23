import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ensureContainerWarm,
  noteContainerActivity,
  keepContainerWarm,
  ContainerWakeError,
  __resetContainerWarmCache,
} from '../../src/lib/container-warm-cache.js';
import { log } from '../../src/lib/logger.js';

const URL = 'http://container.local';
const okFetch = (): typeof fetch =>
  vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

beforeEach(() => {
  __resetContainerWarmCache();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ensureContainerWarm', () => {
  it('cache miss → calls /health; subsequent hit within TTL skips fetch', async () => {
    const f = okFetch();
    vi.stubGlobal('fetch', f);
    await ensureContainerWarm('u1', URL);
    await ensureContainerWarm('u1', URL);
    expect(f).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f).mock.calls[0]?.[0]).toBe(`${URL}/health`);
  });

  it('noteContainerActivity primes cache → ensureContainerWarm does not fetch', async () => {
    const f = okFetch();
    vi.stubGlobal('fetch', f);
    noteContainerActivity('u1');
    await ensureContainerWarm('u1', URL);
    expect(f).not.toHaveBeenCalled();
  });

  it('TTL expiry → re-wakes after 61s', async () => {
    vi.useFakeTimers();
    const f = okFetch();
    vi.stubGlobal('fetch', f);
    await ensureContainerWarm('u1', URL);
    vi.advanceTimersByTime(61_000);
    await ensureContainerWarm('u1', URL);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('concurrent calls for same user dedupe into one /health', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const f = vi.fn(async () => {
      await gate;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', f);

    const p1 = ensureContainerWarm('u1', URL);
    const p2 = ensureContainerWarm('u1', URL);
    release?.();
    await Promise.all([p1, p2]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('non-2xx wake → throws ContainerWakeError and does NOT prime cache', async () => {
    const bad = vi.fn(async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', bad);
    await expect(ensureContainerWarm('u1', URL)).rejects.toBeInstanceOf(ContainerWakeError);
    // cache not primed → next call retries fetch
    const ok = okFetch();
    vi.stubGlobal('fetch', ok);
    await ensureContainerWarm('u1', URL);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('fetch rejection → throws ContainerWakeError', async () => {
    const boom = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', boom);
    await expect(ensureContainerWarm('u1', URL)).rejects.toBeInstanceOf(ContainerWakeError);
  });

  it('logs cold=false for a fast wake and cold=true for a slow one', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const nowSpy = vi.spyOn(performance, 'now');

    // fast: delta 50ms
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(50);
    vi.stubGlobal('fetch', okFetch());
    await ensureContainerWarm('fast', URL);
    expect(info.mock.calls.at(-1)?.[0]).toMatchObject({ event: 'aca.wake', cold: false });

    // slow: delta 2000ms
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(2000);
    vi.stubGlobal('fetch', okFetch());
    await ensureContainerWarm('slow', URL);
    expect(info.mock.calls.at(-1)?.[0]).toMatchObject({ event: 'aca.wake', cold: true });
  });
});

describe('keepContainerWarm (心跳保活)', () => {
  it('每次都无条件 GET /health (不走 60s TTL dedupe)', async () => {
    const f = okFetch();
    vi.stubGlobal('fetch', f);
    keepContainerWarm('u1', URL);
    keepContainerWarm('u1', URL); // 背靠背两次也不去重 — 每次心跳都要重置 KEDA 冷却
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(2));
    expect(vi.mocked(f).mock.calls[0]?.[0]).toBe(`${URL}/health`);
  });

  it('fire-and-forget: fetch reject 不抛错', async () => {
    const f = vi.fn(async () => { throw new Error('boom'); }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', f);
    expect(() => keepContainerWarm('u1', URL)).not.toThrow();
    await vi.waitFor(() => expect(f).toHaveBeenCalled());
  });

  it('ping 成功后续 warm-cache → 后续 ensureContainerWarm 跳过 /health', async () => {
    const f = okFetch();
    vi.stubGlobal('fetch', f);
    keepContainerWarm('u1', URL);
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    await ensureContainerWarm('u1', URL); // warm-cache 已被 keepContainerWarm 续上
    expect(f).toHaveBeenCalledTimes(1);
  });
});
