import { describe, it, expect, afterEach } from 'vitest';
import {
  enqueueThreadTask,
  threadQueueDepth,
  MAX_QUEUE_PER_THREAD,
  __resetThreadSerializerForTests,
} from '../../src/lib/thread-serializer.js';
import {
  storePendingLoop,
  emitLoopEvent,
  __resetPendingLoopsForTests,
} from '../../src/lib/pending-loops.js';

// 注册一个真实 pending loop,让 enqueueThreadTask 的 waitLoopTerminal 能订阅到它,
// 之后用 emitLoopEvent 推终态来释放占用 —— 完全用代码暴露的真实信号驱动,不碰定时器。
const registerLoop = (loopId: string, threadId: string): void => {
  storePendingLoop(
    { loopId, threadId, userId: 'u', source: 'wechat' },
    { hardDeadlineMs: 60_000, onDeadline: () => {} },
  );
};

afterEach(() => {
  __resetThreadSerializerForTests();
  __resetPendingLoopsForTests();
});

describe('thread-serializer', () => {
  it('同一 thread:第二个任务必须等第一个 loop 出终态才派发', async () => {
    const order: string[] = [];
    const task1Ran = Promise.withResolvers<void>();
    const task2Ran = Promise.withResolvers<void>();

    enqueueThreadTask('t1', async () => {
      order.push('d1');
      registerLoop('lp_1', 't1');
      task1Ran.resolve();
      return 'lp_1'; // 占住车道直到 lp_1 终态
    });
    enqueueThreadTask('t1', async () => {
      order.push('d2');
      task2Ran.resolve();
      return null;
    });

    await task1Ran.promise;
    // task1 已派发并进入占用;task2 串在 task1 之后,尚未触发。
    expect(order).toEqual(['d1']);

    emitLoopEvent('lp_1', { type: 'done', reply: 'ok', completion: 'success' });

    await task2Ran.promise;
    expect(order).toEqual(['d1', 'd2']);
  });

  it('不同 thread:互不阻塞,并行推进', async () => {
    const aRan = Promise.withResolvers<void>();
    const bRan = Promise.withResolvers<void>();

    enqueueThreadTask('tA', async () => {
      registerLoop('lp_A', 'tA');
      aRan.resolve();
      return 'lp_A'; // A 占住不释放
    });
    enqueueThreadTask('tB', async () => {
      bRan.resolve();
      return null;
    });

    // B 不因 A 的占用而等待 —— 两者都能推进。
    await Promise.all([aRan.promise, bRan.promise]);

    emitLoopEvent('lp_A', { type: 'fail', error: 'cleanup' });
  });

  it('task 返回 null → 不占用,后继立即接上', async () => {
    const order: string[] = [];
    const lastRan = Promise.withResolvers<void>();

    enqueueThreadTask('t', async () => { order.push('1'); return null; });
    enqueueThreadTask('t', async () => { order.push('2'); lastRan.resolve(); return null; });

    await lastRan.promise;
    expect(order).toEqual(['1', '2']);
  });

  it('task 抛错不卡死车道,后继照常跑', async () => {
    const order: string[] = [];
    const lastRan = Promise.withResolvers<void>();

    enqueueThreadTask('t', async () => { order.push('1'); throw new Error('boom'); });
    enqueueThreadTask('t', async () => { order.push('2'); lastRan.resolve(); return null; });

    await lastRan.promise;
    expect(order).toEqual(['1', '2']);
  });

  it('队列满 → 拒绝;释放一格后又可接纳', async () => {
    const firstRan = Promise.withResolvers<void>();
    const secondRan = Promise.withResolvers<void>();

    for (let i = 0; i < MAX_QUEUE_PER_THREAD; i++) {
      const accepted = enqueueThreadTask('t', async () => {
        registerLoop(`lp_${i}`, 't');
        if (i === 0) firstRan.resolve();
        if (i === 1) secondRan.resolve();
        return `lp_${i}`; // 每个都占住,把车道填满
      });
      expect(accepted).toBe(true);
    }

    expect(threadQueueDepth('t')).toBe(MAX_QUEUE_PER_THREAD);
    expect(enqueueThreadTask('t', async () => null)).toBe(false); // 满 → 拒

    await firstRan.promise; // lp_0 已注册且在占用
    emitLoopEvent('lp_0', { type: 'done', reply: 'x', completion: 'success' });

    await secondRan.promise; // lp_0 释放 → lp_1 接上,腾出一格
    expect(threadQueueDepth('t')).toBe(MAX_QUEUE_PER_THREAD - 1);
    expect(enqueueThreadTask('t', async () => null)).toBe(true);
  });
});
