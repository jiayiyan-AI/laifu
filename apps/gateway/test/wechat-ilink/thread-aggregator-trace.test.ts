import { describe, it, expect, afterEach } from 'vitest';
import {
  aggregateInbound,
  flush,
  __resetThreadAggregatorForTests,
} from '../../src/wechat-ilink/thread-aggregator.js';
import { getTraceId } from '../../src/lib/trace-context.js';

// 直接调 flush() 结算, 不依赖窗口定时器 (规则: 测试不用真实 wall-clock timer)。

afterEach(() => {
  __resetThreadAggregatorForTests();
});

describe('thread-aggregator × burst trace', () => {
  it('onFlush 在 burst trace 上下文里跑, 带到一个 trace_ id', async () => {
    let seen: string | undefined;
    aggregateInbound('t1', { text: 'hi', hasImage: false, onFlush: () => { seen = getTraceId(); } });
    await flush('t1');
    expect(seen).toMatch(/^trace_/);
  });

  it('同一窗口的 upload 与 onFlush 共享同一个 burst trace', async () => {
    let uploadTrace: string | undefined;
    let flushTrace: string | undefined;
    // 第一条带图(走 uploadChain), 第二条纯文本并入同窗口
    aggregateInbound('t2', {
      text: '',
      hasImage: true,
      upload: async () => {
        uploadTrace = getTraceId();
        return { attachments: [], fetchErrors: [] };
      },
      onFlush: () => { flushTrace = getTraceId(); },
    });
    aggregateInbound('t2', { text: '补一句', hasImage: false, onFlush: () => { flushTrace = getTraceId(); } });
    await flush('t2');
    expect(uploadTrace).toMatch(/^trace_/);
    expect(flushTrace).toBe(uploadTrace); // 一个 burst 一个 trace, upload 与派发同源
  });

  it('新窗口换一个新的 burst trace', async () => {
    let first: string | undefined;
    let second: string | undefined;
    aggregateInbound('t3', { text: 'a', hasImage: false, onFlush: () => { first = getTraceId(); } });
    await flush('t3');
    aggregateInbound('t3', { text: 'b', hasImage: false, onFlush: () => { second = getTraceId(); } });
    await flush('t3');
    expect(first).toMatch(/^trace_/);
    expect(second).toMatch(/^trace_/);
    expect(second).not.toBe(first);
  });

  it('flush 外部 (无聚合上下文) getTraceId 仍是 undefined', () => {
    expect(getTraceId()).toBeUndefined();
  });
});
