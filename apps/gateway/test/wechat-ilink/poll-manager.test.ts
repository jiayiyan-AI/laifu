import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

import { dao } from '../../src/db/index.js';
import { PollManager } from '../../src/wechat-ilink/poll-manager.js';
import type { WechatBinding } from '../../src/db/wechat-binding-dao.js';
import type { IlinkClient } from '../../src/wechat-ilink/client.js';

const mockBinding = (id: string, overrides: Partial<WechatBinding> = {}): WechatBinding => ({
  id,
  user_id: 'u_' + id,
  ilink_bot_id: 'ibot_' + id,
  bot_token: 'tok_' + id,
  base_url: 'https://ilink',
  updates_cursor: null,
  is_active: true,
  thread_id: null,
  bound_at: '2026-06-01T00:00:00Z',
  ...overrides,
});

const mockClient = (): IlinkClient => ({
  getUpdates: vi.fn(async () => ({ errcode: 0, msgs: [], get_updates_buf: '' })),
  sendText: vi.fn(async () => {}),
});

const makeRunLoop = () => {
  const refs = new Map<string, any>();
  const runLoop: any = vi.fn((opts: any) => {
    const exited = new Promise<void>((resolve) => {
      refs.set(opts.signal as any, {
        triggerSessionExpired: opts.onSessionExpired,
        triggerCursorUpdate: opts.onCursorUpdate,
        exit: resolve,
        exited: Promise.resolve(),
      });
      opts.signal.addEventListener('abort', () => resolve());
    });
    return exited;
  });
  return { runLoop, refs };
};

describe('PollManager', () => {
  it('startOne 添加到 map, size 自增', () => {
    const { runLoop } = makeRunLoop();
    const mgr = new PollManager({
      onMessageFor: () => async () => {},
      clientFactory: mockClient,
      runLoop,
    });
    mgr.startOne(mockBinding('b1'));
    expect(mgr.size()).toBe(1);
  });

  it('startOne 幂等: 同 id 重入不会起两个', () => {
    const { runLoop } = makeRunLoop();
    const mgr = new PollManager({
      onMessageFor: () => async () => {}, clientFactory: mockClient, runLoop,
    });
    mgr.startOne(mockBinding('b1'));
    mgr.startOne(mockBinding('b1'));
    expect(mgr.size()).toBe(1);
    expect(runLoop).toHaveBeenCalledTimes(1);
  });

  it('stopOne 移除并 abort', async () => {
    const { runLoop } = makeRunLoop();
    const mgr = new PollManager({
      onMessageFor: () => async () => {}, clientFactory: mockClient, runLoop,
    });
    mgr.startOne(mockBinding('b1'));
    expect(mgr.size()).toBe(1);
    mgr.stopOne('b1');
    expect(mgr.size()).toBe(0);
    await new Promise((r) => setImmediate(r));
    const callOpts = (runLoop as any).mock.calls[0]![0];
    expect(callOpts.signal.aborted).toBe(true);
  });

  it('stopOne 不存在的 id 静默 no-op', () => {
    const { runLoop } = makeRunLoop();
    const mgr = new PollManager({
      onMessageFor: () => async () => {}, clientFactory: mockClient, runLoop,
    });
    expect(() => mgr.stopOne('nope')).not.toThrow();
  });

  it('stopAll 清空所有', async () => {
    const { runLoop } = makeRunLoop();
    const mgr = new PollManager({
      onMessageFor: () => async () => {}, clientFactory: mockClient, runLoop,
    });
    mgr.startOne(mockBinding('b1'));
    mgr.startOne(mockBinding('b2'));
    mgr.startOne(mockBinding('b3'));
    expect(mgr.size()).toBe(3);
    await mgr.stopAll();
    expect(mgr.size()).toBe(0);
  });

  it('startAll 从 DAO 拉活跃,逐个启,size = 拉到的数量', async () => {
    vi.mocked(dao.wechatBindings.listActive).mockResolvedValue([mockBinding('a'), mockBinding('b'), mockBinding('c')]);
    const { runLoop } = makeRunLoop();
    const mgr = new PollManager({
      onMessageFor: () => async () => {}, clientFactory: mockClient, runLoop,
    });
    await mgr.startAll();
    expect(mgr.size()).toBe(3);
    expect(runLoop).toHaveBeenCalledTimes(3);
  });

  it('onSessionExpired callback 触发时: DAO.deactivate + 从 map 移除', async () => {
    const { runLoop } = makeRunLoop();
    const mgr = new PollManager({
      onMessageFor: () => async () => {}, clientFactory: mockClient, runLoop,
    });
    mgr.startOne(mockBinding('b1'));
    const opts = (runLoop as any).mock.calls[0]![0];
    await opts.onSessionExpired();
    expect(dao.wechatBindings.deactivate).toHaveBeenCalledWith('b1');
    expect(mgr.size()).toBe(0);
  });

  it('onCursorUpdate callback → DAO.updateCursor', async () => {
    const { runLoop } = makeRunLoop();
    const mgr = new PollManager({
      onMessageFor: () => async () => {}, clientFactory: mockClient, runLoop,
    });
    mgr.startOne(mockBinding('b1', { updates_cursor: 'cur_0' }));
    const opts = (runLoop as any).mock.calls[0]![0];
    await opts.onCursorUpdate('cur_1');
    expect(dao.wechatBindings.updateCursor).toHaveBeenCalledWith('b1', 'cur_1');
  });

  it('clientFactory 收到正确的 bot_token + base_url', () => {
    const factory = vi.fn(() => mockClient());
    const { runLoop } = makeRunLoop();
    const mgr = new PollManager({
      onMessageFor: () => async () => {}, clientFactory: factory, runLoop,
    });
    mgr.startOne(mockBinding('b1', { bot_token: 'TK_X', base_url: 'https://x.ilink' }));
    expect(factory).toHaveBeenCalledWith({ botToken: 'TK_X', baseUrl: 'https://x.ilink' });
  });

  it('onMessageFor 工厂被调,返回 callback 作为 onMessage 注给 loop', () => {
    const innerHandler = vi.fn(async () => {});
    const factory = vi.fn(() => innerHandler);
    const { runLoop } = makeRunLoop();
    const mgr = new PollManager({
      onMessageFor: factory, clientFactory: mockClient, runLoop,
    });
    const binding = mockBinding('b1');
    mgr.startOne(binding);
    expect(factory).toHaveBeenCalledWith(
      binding,
      expect.objectContaining({ getUpdates: expect.any(Function), sendText: expect.any(Function) }),
    );
    const opts = (runLoop as any).mock.calls[0]![0];
    expect(opts.onMessage).toBe(innerHandler);
  });
});
