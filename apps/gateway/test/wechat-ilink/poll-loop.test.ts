import { describe, it, expect, vi } from 'vitest';
import { pollLoop } from '../../src/wechat-ilink/poll-loop.js';
import type { IlinkClient } from '../../src/wechat-ilink/client.js';

const makeClient = (
  responses: Array<any | Error>,
): { client: IlinkClient; getUpdatesCalls: Array<{ cursor: string | null }> } => {
  const calls: Array<{ cursor: string | null }> = [];
  let i = 0;
  const client: IlinkClient = {
    getUpdates: vi.fn(async (cursor, opts) => {
      calls.push({ cursor });
      const r = responses[i++];
      if (r === undefined) {
        // 用完预设 → 挂到 abort 才退,模拟真实 getUpdates 对 signal 的尊重
        return new Promise<any>((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => {
            const err = new Error('aborted'); err.name = 'AbortError'; reject(err);
          });
        });
      }
      if (r instanceof Error) throw r;
      return r;
    }),
    sendText: vi.fn(async () => {}),
  };
  return { client, getUpdatesCalls: calls };
};

const fastSleep = () => Promise.resolve();   // 测试里不真的等

describe('pollLoop', () => {
  it('happy path: dispatches each msg via onMessage', async () => {
    const { client } = makeClient([
      { errcode: 0, msgs: [{ message_id: 'a' }, { message_id: 'b' }], get_updates_buf: 'cur_2' },
    ]);
    const onMessage = vi.fn(async () => {});
    const onCursorUpdate = vi.fn(async () => {});
    const onSessionExpired = vi.fn(async () => {});
    const ac = new AbortController();

    const p = pollLoop({
      client, initialCursor: 'cur_1', signal: ac.signal,
      onMessage, onCursorUpdate, onSessionExpired,
      sleep: fastSleep,
    });

    // Yield一两次让 loop 处理完第 1 批,再 abort
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    ac.abort();
    await p;

    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage).toHaveBeenNthCalledWith(1, { message_id: 'a' });
    expect(onMessage).toHaveBeenNthCalledWith(2, { message_id: 'b' });
    expect(onCursorUpdate).toHaveBeenCalledWith('cur_2');
    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  it('does NOT call onCursorUpdate when cursor unchanged', async () => {
    const { client } = makeClient([
      { errcode: 0, msgs: [], get_updates_buf: 'cur_1' },     // 一样
    ]);
    const onCursorUpdate = vi.fn(async () => {});
    const ac = new AbortController();
    const p = pollLoop({
      client, initialCursor: 'cur_1', signal: ac.signal,
      onMessage: async () => {},
      onCursorUpdate,
      onSessionExpired: async () => {},
      sleep: fastSleep,
    });
    await new Promise((r) => setImmediate(r));
    ac.abort();
    await p;
    expect(onCursorUpdate).not.toHaveBeenCalled();
  });

  it('errcode=-14 → onSessionExpired + return (no further polls)', async () => {
    const { client } = makeClient([
      { errcode: -14, msgs: [], get_updates_buf: '' },
      { errcode: 0, msgs: [{ message_id: 'should_not_dispatch' }], get_updates_buf: 'cur_X' },
    ]);
    const onMessage = vi.fn(async () => {});
    const onSessionExpired = vi.fn(async () => {});

    await pollLoop({
      client, initialCursor: null, signal: new AbortController().signal,
      onMessage, onCursorUpdate: async () => {}, onSessionExpired,
      sleep: fastSleep,
    });

    expect(onSessionExpired).toHaveBeenCalledOnce();
    expect(onMessage).not.toHaveBeenCalled();
    // 第二个 response 不应该被消费
    expect(client.getUpdates).toHaveBeenCalledTimes(1);
  });

  it('signal abort → loop returns', async () => {
    const { client } = makeClient([]);                  // getUpdates 永远 pending
    const ac = new AbortController();
    const p = pollLoop({
      client, initialCursor: null, signal: ac.signal,
      onMessage: async () => {},
      onCursorUpdate: async () => {},
      onSessionExpired: async () => {},
      sleep: fastSleep,
    });
    setImmediate(() => ac.abort());
    await expect(p).resolves.toBeUndefined();
  });

  it('onMessage throwing does NOT kill the loop', async () => {
    const { client } = makeClient([
      { errcode: 0, msgs: [{ message_id: 'a' }, { message_id: 'b' }], get_updates_buf: 'cur_1' },
    ]);
    const onMessage = vi.fn(async (msg: any) => {
      if (msg.message_id === 'a') throw new Error('handler crashed');
    });
    const ac = new AbortController();
    const p = pollLoop({
      client, initialCursor: null, signal: ac.signal,
      onMessage, onCursorUpdate: async () => {}, onSessionExpired: async () => {},
      sleep: fastSleep,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    ac.abort();
    await p;
    expect(onMessage).toHaveBeenCalledTimes(2);     // 'a' 失败后 'b' 仍被尝试
  });

  it('exception in getUpdates → retries after backoff', async () => {
    const { client } = makeClient([
      new Error('network'),
      { errcode: 0, msgs: [{ message_id: 'recovered' }], get_updates_buf: 'cur_2' },
    ]);
    const onMessage = vi.fn(async () => {});
    const ac = new AbortController();
    const p = pollLoop({
      client, initialCursor: null, signal: ac.signal,
      onMessage, onCursorUpdate: async () => {}, onSessionExpired: async () => {},
      sleep: fastSleep,
    });
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    ac.abort();
    await p;
    // 1) network error 2) recovered 3) 第三次 hang (mock 用尽) — abort 时落在第 3 次
    expect((client.getUpdates as any).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(onMessage).toHaveBeenCalledWith({ message_id: 'recovered' });
  });

  it('AbortError from getUpdates → loop returns silently', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    const { client } = makeClient([abortErr]);
    await expect(pollLoop({
      client, initialCursor: null, signal: new AbortController().signal,
      onMessage: async () => {},
      onCursorUpdate: async () => {},
      onSessionExpired: async () => {},
      sleep: fastSleep,
    })).resolves.toBeUndefined();
    expect(client.getUpdates).toHaveBeenCalledTimes(1);
  });
});
