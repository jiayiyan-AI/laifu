import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  aggregateInbound,
  hasPendingAggregation,
  __resetThreadAggregatorForTests,
  TEXT_GRACE_MS,
  IMAGE_WAIT_MS,
  SPLIT_WAIT_MS,
  HARD_CAP_MS,
  SPLIT_THRESHOLD,
  type AggregatedBurst,
} from '../../src/wechat-ilink/thread-aggregator.js';
import type { WechatAttachmentRef } from '@lingxi/shared';

const att = (path: string): WechatAttachmentRef => ({
  kind: 'image', cache_path: path, content_type: 'image/jpeg', size: 100,
});

afterEach(() => {
  __resetThreadAggregatorForTests();
  vi.useRealTimers();
});

describe('thread-aggregator', () => {
  it('text+image 同条 → 一次 onFlush, 合并 texts+attachments', async () => {
    vi.useFakeTimers();
    const flushed: AggregatedBurst[] = [];
    aggregateInbound('t1', {
      text: '看图',
      hasImage: true,
      upload: async () => ({ attachments: [att('/c/a.jpg')], fetchErrors: [] }),
      onFlush: (b) => flushed.push(b),
    });
    await vi.advanceTimersByTimeAsync(TEXT_GRACE_MS + 10);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]!.texts).toEqual(['看图']);
    expect(flushed[0]!.attachments.map((a) => a.cache_path)).toEqual(['/c/a.jpg']);
    expect(hasPendingAggregation('t1')).toBe(false);
  });

  it('图先到→文字后到(拆成两条) → 合并一轮', async () => {
    vi.useFakeTimers();
    const flushed: AggregatedBurst[] = [];
    // 图先到(纯图, IMAGE_WAIT 长窗)
    aggregateInbound('t1', {
      text: '',
      hasImage: true,
      upload: async () => ({ attachments: [att('/c/a.jpg')], fetchErrors: [] }),
      onFlush: (b) => flushed.push(b),
    });
    // 1s 后文字到(在 IMAGE_WAIT 内)
    await vi.advanceTimersByTimeAsync(1000);
    expect(flushed).toHaveLength(0);
    aggregateInbound('t1', { text: '这是什么', hasImage: false, onFlush: (b) => flushed.push(b) });
    await vi.advanceTimersByTimeAsync(TEXT_GRACE_MS + 10);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]!.texts).toEqual(['这是什么']);
    expect(flushed[0]!.attachments.map((a) => a.cache_path)).toEqual(['/c/a.jpg']);
  });

  it('upload 比窗口慢 → flush 先 await uploadChain, 不漏图', async () => {
    vi.useFakeTimers();
    const flushed: AggregatedBurst[] = [];
    let resolveUpload!: () => void;
    const gate = new Promise<void>((r) => { resolveUpload = r; });
    aggregateInbound('t1', {
      text: '看图',
      hasImage: true,
      upload: () => gate.then(() => ({ attachments: [att('/c/slow.jpg')], fetchErrors: [] })),
      onFlush: (b) => flushed.push(b),
    });
    // 窗口到期但上传未完 → 还没 onFlush
    await vi.advanceTimersByTimeAsync(TEXT_GRACE_MS + 10);
    expect(flushed).toHaveLength(0);
    // 上传完成 → flush 的 await 继续 → onFlush
    resolveUpload();
    await vi.advanceTimersByTimeAsync(1);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]!.attachments.map((a) => a.cache_path)).toEqual(['/c/slow.jpg']);
  });

  it('长文(近 ~2048 切分阈值)用更长窗口 SPLIT_WAIT', async () => {
    vi.useFakeTimers();
    const flushed: AggregatedBurst[] = [];
    aggregateInbound('t1', {
      text: 'x'.repeat(SPLIT_THRESHOLD),
      hasImage: false,
      onFlush: (b) => flushed.push(b),
    });
    // TEXT_GRACE 到期未触发(用了 SPLIT_WAIT)
    await vi.advanceTimersByTimeAsync(TEXT_GRACE_MS + 10);
    expect(flushed).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(SPLIT_WAIT_MS - TEXT_GRACE_MS + 10);
    expect(flushed).toHaveLength(1);
  });

  it('连打不断重排定时器, 但 hard cap 强制结算(不无限推迟)', async () => {
    vi.useFakeTimers();
    const flushed: AggregatedBurst[] = [];
    const mk = () => aggregateInbound('t1', { text: 'a', hasImage: false, onFlush: (b) => flushed.push(b) });
    mk();
    let elapsed = 0;
    // 每 500ms 重发一次(重排 TEXT_GRACE); hard cap 应在 ~HARD_CAP_MS 强制 flush
    while (flushed.length === 0 && elapsed < HARD_CAP_MS + 1000) {
      await vi.advanceTimersByTimeAsync(500);
      elapsed += 500;
      if (flushed.length === 0) mk();
    }
    expect(flushed).toHaveLength(1);
    expect(elapsed).toBeLessThanOrEqual(HARD_CAP_MS + 500);
  });

  it('flush 后新消息建新 slot, 不串到上一轮', async () => {
    vi.useFakeTimers();
    const flushed: AggregatedBurst[] = [];
    aggregateInbound('t1', { text: 'first', hasImage: false, onFlush: (b) => flushed.push(b) });
    await vi.advanceTimersByTimeAsync(TEXT_GRACE_MS + 10);
    expect(flushed).toHaveLength(1);
    expect(hasPendingAggregation('t1')).toBe(false);

    aggregateInbound('t1', { text: 'second', hasImage: false, onFlush: (b) => flushed.push(b) });
    await vi.advanceTimersByTimeAsync(TEXT_GRACE_MS + 10);
    expect(flushed).toHaveLength(2);
    expect(flushed[1]!.texts).toEqual(['second']);
  });

  it('不同 thread 窗口独立并行', async () => {
    vi.useFakeTimers();
    const fa: AggregatedBurst[] = [];
    const fb: AggregatedBurst[] = [];
    aggregateInbound('a', { text: 'x', hasImage: false, onFlush: (b) => fa.push(b) });
    aggregateInbound('b', { text: 'y', hasImage: false, onFlush: (b) => fb.push(b) });
    await vi.advanceTimersByTimeAsync(TEXT_GRACE_MS + 10);
    expect(fa).toHaveLength(1);
    expect(fb).toHaveLength(1);
    expect(fa[0]!.texts).toEqual(['x']);
    expect(fb[0]!.texts).toEqual(['y']);
  });

  it('多条文字连打 → 拼成一个 burst(各片段保序)', async () => {
    vi.useFakeTimers();
    const flushed: AggregatedBurst[] = [];
    aggregateInbound('t1', { text: '第一段', hasImage: false, onFlush: (b) => flushed.push(b) });
    await vi.advanceTimersByTimeAsync(300);
    aggregateInbound('t1', { text: '第二段', hasImage: false, onFlush: (b) => flushed.push(b) });
    await vi.advanceTimersByTimeAsync(TEXT_GRACE_MS + 10);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]!.texts).toEqual(['第一段', '第二段']);
  });
});
