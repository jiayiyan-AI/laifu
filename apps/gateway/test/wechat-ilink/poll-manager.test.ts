import { describe, it, expect, vi } from 'vitest';
import { PollManager } from '../../src/wechat-ilink/poll-manager.js';
import type { WechatBinding, WechatBindingDao } from '../../src/db/wechat-binding-dao.js';
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

const makeDao = (): WechatBindingDao & {
  __activeRows: WechatBinding[];
  __deactivated: string[];
  __cursorUpdates: Array<{ id: string; cursor: string }>;
} => ({
  __activeRows: [],
  __deactivated: [],
  __cursorUpdates: [],
  listActive: vi.fn(async function (this: any) { return this.__activeRows; }),
  getByUserId: vi.fn(async () => null),
  upsertByUserId: vi.fn(async () => mockBinding('upserted')),
  updateCursor: vi.fn(async function (this: any, id, c) { this.__cursorUpdates.push({ id, cursor: c }); }),
  bindThread: vi.fn(async () => {}),
  deactivate: vi.fn(async function (this: any, id) { this.__deactivated.push(id); }),
} as any);

const mockClient = (): IlinkClient => ({
  getUpdates: vi.fn(async () => ({ errcode: 0, msgs: [], get_updates_buf: '' })),
  sendText: vi.fn(async () => {}),
});

// runLoop 测试替身: 暴露 callbacks 供测试触发,signal abort 时退出
type RunLoopRef = {
  triggerSessionExpired: () => Promise<void>;
  triggerCursorUpdate: (cursor: string) => Promise<void>;
  exit: () => void;
  exited: Promise<void>;
};

const makeRunLoop = () => {
  const refs = new Map<string, RunLoopRef>();
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
    const dao = makeDao();
    const { runLoop } = makeRunLoop();
    const mgr = new PollManager({
      dao,
      onMessageFor: () => async () => {},
      clientFactory: mockClient,
      runLoop,
    });
    mgr.startOne(mockBinding('b1'));
    expect(mgr.size()).toBe(1);
  });

  it('startOne 幂等: 同 id 重入不会起两个', () => {
    const dao = makeDao();
    const { runLoop } = makeRunLoop();
    const mgr = new PollManager({
      dao, onMessageFor: () => async () => {}, clientFactory: mockClient, runLoop,
    });
    mgr.startOne(mockBinding('b1'));
    mgr.startOne(mockBinding('b1'));
    expect(mgr.size()).toBe(1);
    expect(runLoop).toHaveBeenCalledTimes(1);
  });

  it('stopOne 移除并 abort', async () => {
    const dao = makeDao();
    const { runLoop } = makeRunLoop();
    const mgr = new PollManager({
      dao, onMessageFor: () => async () => {}, clientFactory: mockClient, runLoop,
    });
    mgr.startOne(mockBinding('b1'));
    expect(mgr.size()).toBe(1);
    mgr.stopOne('b1');
    expect(mgr.size()).toBe(0);
    // 让 floating promise 的 .then 跑一遍
    await new Promise((r) => setImmediate(r));
    // 应该传给 runLoop 一个 already-aborted signal
    const callOpts = (runLoop as any).mock.calls[0]![0];
    expect(callOpts.signal.aborted).toBe(true);
  });

  it('stopOne 不存在的 id 静默 no-op', () => {
    const dao = makeDao();
    const { runLoop } = makeRunLoop();
    const mgr = new PollManager({
      dao, onMessageFor: () => async () => {}, clientFactory: mockClient, runLoop,
    });
    expect(() => mgr.stopOne('nope')).not.toThrow();
  });

  it('stopAll 清空所有', async () => {
    const dao = makeDao();
    const { runLoop } = makeRunLoop();
    const mgr = new PollManager({
      dao, onMessageFor: () => async () => {}, clientFactory: mockClient, runLoop,
    });
    mgr.startOne(mockBinding('b1'));
    mgr.startOne(mockBinding('b2'));
    mgr.startOne(mockBinding('b3'));
    expect(mgr.size()).toBe(3);
    await mgr.stopAll();
    expect(mgr.size()).toBe(0);
  });

  it('startAll 从 DAO 拉活跃,逐个启,size = 拉到的数量', async () => {
    const dao = makeDao();
    dao.__activeRows = [mockBinding('a'), mockBinding('b'), mockBinding('c')];
    const { runLoop } = makeRunLoop();
    const mgr = new PollManager({
      dao, onMessageFor: () => async () => {}, clientFactory: mockClient, runLoop,
    });
    await mgr.startAll();
    expect(mgr.size()).toBe(3);
    expect(runLoop).toHaveBeenCalledTimes(3);
  });

  it('onSessionExpired callback 触发时: DAO.deactivate + 从 map 移除', async () => {
    const dao = makeDao();
    const { runLoop, refs } = makeRunLoop();
    const mgr = new PollManager({
      dao, onMessageFor: () => async () => {}, clientFactory: mockClient, runLoop,
    });
    mgr.startOne(mockBinding('b1'));
    // 拿到 PollManager 注的 onSessionExpired,模拟 iLink 返 -14
    const opts = (runLoop as any).mock.calls[0]![0];
    await opts.onSessionExpired();
    expect(dao.__deactivated).toContain('b1');
    expect(mgr.size()).toBe(0);
    void refs;     // unused but keep for symmetry
  });

  it('onCursorUpdate callback → DAO.updateCursor', async () => {
    const dao = makeDao();
    const { runLoop } = makeRunLoop();
    const mgr = new PollManager({
      dao, onMessageFor: () => async () => {}, clientFactory: mockClient, runLoop,
    });
    mgr.startOne(mockBinding('b1', { updates_cursor: 'cur_0' }));
    const opts = (runLoop as any).mock.calls[0]![0];
    await opts.onCursorUpdate('cur_1');
    expect(dao.__cursorUpdates).toEqual([{ id: 'b1', cursor: 'cur_1' }]);
  });

  it('clientFactory 收到正确的 bot_token + base_url', () => {
    const dao = makeDao();
    const factory = vi.fn(() => mockClient());
    const { runLoop } = makeRunLoop();
    const mgr = new PollManager({
      dao, onMessageFor: () => async () => {}, clientFactory: factory, runLoop,
    });
    mgr.startOne(mockBinding('b1', { bot_token: 'TK_X', base_url: 'https://x.ilink' }));
    expect(factory).toHaveBeenCalledWith({ botToken: 'TK_X', baseUrl: 'https://x.ilink' });
  });

  it('onMessageFor 工厂被调,返回 callback 作为 onMessage 注给 loop', () => {
    const dao = makeDao();
    const innerHandler = vi.fn(async () => {});
    const factory = vi.fn(() => innerHandler);
    const { runLoop } = makeRunLoop();
    const mgr = new PollManager({
      dao, onMessageFor: factory, clientFactory: mockClient, runLoop,
    });
    const binding = mockBinding('b1');
    mgr.startOne(binding);
    expect(factory).toHaveBeenCalledWith(binding);
    const opts = (runLoop as any).mock.calls[0]![0];
    expect(opts.onMessage).toBe(innerHandler);
  });
});
