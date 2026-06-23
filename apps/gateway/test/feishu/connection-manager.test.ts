/**
 * Tests for feishu/connection-manager.ts
 *
 * 对标 wechat-ilink/poll-manager.test.ts 的套路:
 *   - vi.mock dao → 注入 mock feishuBindings.listActive
 *   - wsFactory / clientFactory 注入 fake 对象, 避免真连 SDK
 *   - 测: startAll 起 N 条 WS; startOne 幂等; stopOne 减 size
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

import { dao } from '../../src/db/index.js';
import { FeishuConnectionManager } from '../../src/feishu/connection-manager.js';
import type { FeishuBinding } from '../../src/db/feishu-binding-dao.js';

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

const mockBinding = (id: string, overrides: Partial<FeishuBinding> = {}): FeishuBinding => ({
  id,
  user_id: 'u_' + id,
  app_id: 'cli_' + id,
  app_secret: 'sec_' + id,
  domain: 'feishu',
  owner_open_id: 'ou_' + id,
  thread_id: null,
  status: 'active',
  is_active: true,
  bound_at: '2026-06-01T00:00:00Z',
  ...overrides,
});

/**
 * 创建一个假 WSClient: start/close 都是 vi.fn()。
 * start 返回 Promise<void> 永不 resolve (模拟持久 WS 连接)。
 */
const makeFakeWs = () => ({
  start: vi.fn(() => new Promise<void>(() => { /* hangs, like a real WS */ })),
  close: vi.fn(),
});

/** 假 Lark.Client: 测试里只需要是个对象 */
const makeFakeClient = () => ({} as any);

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

describe('FeishuConnectionManager', () => {
  it('startOne 对单个 binding 起一条 WS 连接, size = 1', () => {
    const fakeWs = makeFakeWs();
    const mgr = new FeishuConnectionManager({
      onMessageFor: () => async () => {},
      wsFactory: () => fakeWs as any,
      clientFactory: makeFakeClient,
    });

    mgr.startOne(mockBinding('b1'));

    expect(mgr.size()).toBe(1);
    expect(fakeWs.start).toHaveBeenCalledTimes(1);
    // start 收到 { eventDispatcher: EventDispatcher }
    const arg = fakeWs.start.mock.calls[0]?.[0] as any;
    expect(arg).toHaveProperty('eventDispatcher');
  });

  it('startOne 幂等: 同 binding.id 两次 size 仍 1, ws.start 只调一次', () => {
    const fakeWs = makeFakeWs();
    const mgr = new FeishuConnectionManager({
      onMessageFor: () => async () => {},
      wsFactory: () => fakeWs as any,
      clientFactory: makeFakeClient,
    });

    mgr.startOne(mockBinding('b1'));
    mgr.startOne(mockBinding('b1'));

    expect(mgr.size()).toBe(1);
    expect(fakeWs.start).toHaveBeenCalledTimes(1);
  });

  it('stopOne 后 size 减 1, ws.close 被调', () => {
    const fakeWs = makeFakeWs();
    const mgr = new FeishuConnectionManager({
      onMessageFor: () => async () => {},
      wsFactory: () => fakeWs as any,
      clientFactory: makeFakeClient,
    });

    mgr.startOne(mockBinding('b1'));
    expect(mgr.size()).toBe(1);

    mgr.stopOne('b1');
    expect(mgr.size()).toBe(0);
    expect(fakeWs.close).toHaveBeenCalledTimes(1);
  });

  it('stopOne 不存在的 id 静默 no-op', () => {
    const mgr = new FeishuConnectionManager({
      onMessageFor: () => async () => {},
      wsFactory: () => makeFakeWs() as any,
      clientFactory: makeFakeClient,
    });

    expect(() => mgr.stopOne('nope')).not.toThrow();
    expect(mgr.size()).toBe(0);
  });

  it('startAll 对 2 条 active binding 起 2 条 WS, size = 2', async () => {
    const ws1 = makeFakeWs();
    const ws2 = makeFakeWs();
    const wsFactoryCalls: any[] = [];

    vi.mocked(dao.feishuBindings.listActive).mockResolvedValue([
      mockBinding('a1'),
      mockBinding('a2'),
    ]);

    const mgr = new FeishuConnectionManager({
      onMessageFor: () => async () => {},
      wsFactory: (b) => {
        const ws = b.id === 'a1' ? ws1 : ws2;
        wsFactoryCalls.push(b.id);
        return ws as any;
      },
      clientFactory: makeFakeClient,
    });

    await mgr.startAll();

    expect(mgr.size()).toBe(2);
    expect(ws1.start).toHaveBeenCalledTimes(1);
    expect(ws2.start).toHaveBeenCalledTimes(1);
    expect(wsFactoryCalls).toEqual(['a1', 'a2']);
  });

  it('stopAll 清空所有连接, ws.close 全部被调', async () => {
    const ws1 = makeFakeWs();
    const ws2 = makeFakeWs();
    const wsList = [ws1, ws2];
    let wsIdx = 0;

    const mgr = new FeishuConnectionManager({
      onMessageFor: () => async () => {},
      wsFactory: () => wsList[wsIdx++] as any,
      clientFactory: makeFakeClient,
    });

    mgr.startOne(mockBinding('b1'));
    mgr.startOne(mockBinding('b2'));
    expect(mgr.size()).toBe(2);

    await mgr.stopAll();
    expect(mgr.size()).toBe(0);
    expect(ws1.close).toHaveBeenCalledTimes(1);
    expect(ws2.close).toHaveBeenCalledTimes(1);
  });

  it('onMessageFor 工厂被调, handler 被注册到 EventDispatcher', async () => {
    const innerHandler = vi.fn(async () => {});
    const onMessageFor = vi.fn(() => innerHandler);
    const fakeWs = makeFakeWs();
    const fakeClient = makeFakeClient();

    const mgr = new FeishuConnectionManager({
      onMessageFor,
      wsFactory: () => fakeWs as any,
      clientFactory: () => fakeClient,
    });

    const binding = mockBinding('b1');
    mgr.startOne(binding);

    // onMessageFor 收到 (binding, client)
    expect(onMessageFor).toHaveBeenCalledTimes(1);
    expect(onMessageFor).toHaveBeenCalledWith(binding, fakeClient);

    // EventDispatcher 已传给 ws.start
    const startArg = fakeWs.start.mock.calls[0]?.[0] as any;
    expect(startArg).toHaveProperty('eventDispatcher');

    // 通过 dispatcher.invoke 触发事件 → innerHandler 被调
    // 使用 v2 事件格式 (含 schema 字段) + needCheck:false (对齐 WS path 实际调用方式)
    const dispatcher = startArg.eventDispatcher;
    const fakeEvent = { message: { message_id: 'm1', message_type: 'text', content: '{}' }, sender: {} };
    await dispatcher.invoke(
      { schema: '2.0', header: { event_type: 'im.message.receive_v1' }, event: fakeEvent },
      { needCheck: false },
    );
    expect(innerHandler).toHaveBeenCalledTimes(1);
  });
});
