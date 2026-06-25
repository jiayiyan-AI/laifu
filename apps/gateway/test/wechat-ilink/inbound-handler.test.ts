import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

const { dropThreadSilently } = vi.hoisted(() => ({ dropThreadSilently: vi.fn() }));
vi.mock('../../src/lib/drop-thread.js', () => ({ dropThreadSilently }));

import { dao } from '../../src/db/index.js';
import { makeHandleInbound, wechatReplyContexts } from '../../src/wechat-ilink/inbound-handler.js';
import { dropThreadSilently } from '../../src/lib/drop-thread.js';
import type { WechatBinding } from '../../src/db/wechat-binding-dao.js';
import type { IlinkClient } from '../../src/wechat-ilink/client.js';
import {
  __whenDispatchedForTests,
  __resetThreadSerializerForTests,
} from '../../src/lib/thread-serializer.js';
import {
  __whenAggregatedForTests,
  __resetThreadAggregatorForTests,
} from '../../src/wechat-ilink/thread-aggregator.js';
import { emitLoopEvent, __resetPendingLoopsForTests } from '../../src/lib/pending-loops.js';

/** 聚合层 + 串行车道两段 drain: 先 flush 窗口(→onFlush 进车道), 再等车道派发结算。 */
const settle = async (): Promise<void> => {
  await __whenAggregatedForTests();
  await __whenDispatchedForTests();
};

const mockBinding = (overrides: Partial<WechatBinding> = {}): WechatBinding => ({
  id: 'bind_1',
  user_id: 'u_alice',
  ilink_bot_id: 'ibot_x',
  bot_token: 'tok',
  base_url: 'https://i',
  updates_cursor: null,
  is_active: true,
  thread_id: null,
  bound_at: '2026-06-01T00:00:00Z',
  ...overrides,
});

const validInbound = (text = '你好') => ({
  message_id: 'm1',
  message_type: 1,
  message_state: 0,
  from_user_id: 'wxid_friend',
  context_token: 'ctx_xyz',
  item_list: [{ type: 1, text_item: { text } }],
});

const mockClient = (): IlinkClient => ({
  getUpdates: vi.fn(),
  sendText: vi.fn(async () => {}),
});

// 装 mock fetch 到全局 (vitest unstubGlobals:true 每个测试后自动还原), 返回 spy 供断言。
const stubFetch = (impl?: () => Promise<Response>): ReturnType<typeof vi.fn> => {
  const f = vi.fn(impl);
  vi.stubGlobal('fetch', f as unknown as typeof fetch);
  return f;
};

describe('handleInbound', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset dao mocks for each test
    vi.mocked(dao.threads.create).mockImplementation(async (row: any) => ({
      ...row, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), archived: false,
    }));
    vi.mocked(dao.cache.get).mockReturnValue({
      user_id: 'u_alice',
      status: 'ready',
      container_url: 'http://container:8080',
    } as any);
    vi.mocked(dao.usage.getBalance).mockResolvedValue({
      balance_cny: 10, free_quota_cny_month: 5, used_cny_month: 0, period_start: '2026-01-01',
    });
  });

  afterEach(() => {
    __resetThreadAggregatorForTests();
    __resetThreadSerializerForTests();
    __resetPendingLoopsForTests();
  });

  it('happy path: 解析 → 建 thread → 插消息 → 创建 loop → dispatch 202', async () => {
    const fetchImpl = stubFetch(async () => new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    const client = mockClient();
    const handle = makeHandleInbound()(mockBinding(), client);

    await handle(validInbound('hello'));
    await settle();

    // 建了 wechat thread
    expect(dao.threads.create).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 'u_alice',
      source: 'wechat',
      title: '微信',
    }));
    expect(dao.wechatBindings.bindThread).toHaveBeenCalled();

    // 插入 user 消息
    expect(dao.messages.insert).toHaveBeenCalledWith(expect.objectContaining({
      role: 'user',
      content: 'hello',
      source: 'wechat',
    }));

    // 创建 agent loop
    expect(dao.agentLoops.create).toHaveBeenCalled();

    // 调 dispatch
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://container:8080/chat',
      expect.objectContaining({ method: 'POST' }),
    );
    const callBody = JSON.parse((fetchImpl as any).mock.calls[0]![1].body);
    expect(callBody.message).toBe('hello');
    expect(callBody.source).toBe('wechat');
    expect(callBody.session_id).toMatch(/^wechat:thr_/);
    expect(callBody.callback).toBeDefined();
    expect(callBody.callback.loop_id).toMatch(/^lp_/);

    // 回复上下文已存入 map
    const loopId = vi.mocked(dao.agentLoops.create).mock.calls[0]![0].id;
    const ctx = wechatReplyContexts.get(loopId);
    expect(ctx).toBeDefined();
    expect(ctx!.toUserId).toBe('wxid_friend');
    wechatReplyContexts.delete(loopId);
  });

  it('binding.thread_id 已存在 → 复用,不建新 thread', async () => {
    const fetchImpl = stubFetch(async () => new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    const binding = mockBinding({ thread_id: 'thr_existing' });
    const client = mockClient();

    await makeHandleInbound()(binding, client)(validInbound());
    await settle();

    expect(dao.threads.create).not.toHaveBeenCalled();
    expect(dao.wechatBindings.bindThread).not.toHaveBeenCalled();
    const callBody = JSON.parse((fetchImpl as any).mock.calls[0]![1].body);
    expect(callBody.session_id).toBe('wechat:thr_existing');
    for (const [k] of wechatReplyContexts) wechatReplyContexts.delete(k);
  });

  it('第二条消息复用 thread_id (in-memory 更新)', async () => {
    const fetchImpl = stubFetch(async () => new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    const binding = mockBinding();
    const client = mockClient();
    const handle = makeHandleInbound()(binding, client);

    await handle(validInbound('one'));
    await settle();
    const loop1 = vi.mocked(dao.agentLoops.create).mock.calls[0]![0].id;
    emitLoopEvent(loop1, { type: 'done', reply: 'x', completion: 'success' });
    await handle(validInbound('two'));
    await settle();

    expect(dao.threads.create).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [k] of wechatReplyContexts) wechatReplyContexts.delete(k);
  });

  it('parseInbound 返 null → 静默 return,不调 dispatch', async () => {
    const fetchImpl = stubFetch();
    const client = mockClient();
    const handle = makeHandleInbound()(mockBinding(), client);

    await handle({ ...validInbound(), message_type: 2 });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(client.sendText).not.toHaveBeenCalled();
  });

  it('容器没 ready → 发兜底文案 + 不调 dispatch', async () => {
    vi.mocked(dao.cache.get).mockReturnValue(null);
    const fetchImpl = stubFetch();
    const client = mockClient();
    const handle = makeHandleInbound()(mockBinding(), client);

    await handle(validInbound());
    await settle();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(client.sendText).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringMatching(/初始化|稍后/),
    }));
  });

  it('dispatch 返非 202 → complete loop fail + 发兜底文案', async () => {
    const fetchImpl = stubFetch(async () => new Response('err', { status: 500 }));
    const client = mockClient();

    await makeHandleInbound()(mockBinding(), client)(validInbound());
    await settle();

    expect(dao.agentLoops.complete).toHaveBeenCalledWith(expect.any(String), 'fail');
    expect(client.sendText).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringMatching(/失败|稍后/),
    }));
  });

  it('/new without args: creates fresh thread + bindThread + ack, no Hermes call', async () => {
    const fetchImpl = stubFetch(async () => new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    const binding = mockBinding({ thread_id: 'thr_old' });
    const client = mockClient();

    await makeHandleInbound()(binding, client)(validInbound('/new'));

    // 建了新 thread + bind 到 binding
    expect(dao.threads.create).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 'u_alice', source: 'wechat', title: '微信',
    }));
    expect(dao.wechatBindings.bindThread).toHaveBeenCalled();
    // binding 的 thread_id 已就地更新到新 id (后续轮次复用)
    expect(binding.thread_id).not.toBe('thr_old');
    // 发了"已开新会话"提示
    expect(client.sendText).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringMatching(/已开启新会话/),
    }));
    // 不调 Hermes,不写 user msg,不建 loop
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dao.messages.insert).not.toHaveBeenCalled();
    expect(dao.agentLoops.create).not.toHaveBeenCalled();
  });

  it('/new with args: creates fresh thread + dispatches args as first message', async () => {
    const fetchImpl = stubFetch(async () => new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    const binding = mockBinding({ thread_id: 'thr_old' });
    const client = mockClient();

    await makeHandleInbound()(binding, client)(validInbound('/new 顺便问一下天气'));
    await settle();

    // 建了新 thread
    expect(dao.threads.create).toHaveBeenCalled();
    const newThreadId = vi.mocked(dao.threads.create).mock.calls[0]![0].id;
    expect(binding.thread_id).toBe(newThreadId);
    // 发了 ack(带 args 时先发"已开启新会话,正在处理…")
    expect(client.sendText).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringMatching(/已开启新会话.*正在处理/),
    }));
    // user msg 内容是 args 部分,不含 /new
    expect(dao.messages.insert).toHaveBeenCalledWith(expect.objectContaining({
      role: 'user', content: '顺便问一下天气', source: 'wechat', thread_id: newThreadId,
    }));
    // 调了 Hermes, message 是 args
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl as any).mock.calls[0]![1].body);
    expect(body.message).toBe('顺便问一下天气');
    expect(body.session_id).toBe(`wechat:${newThreadId}`);
    for (const [k] of wechatReplyContexts) wechatReplyContexts.delete(k);
  });

  it('non-/new intercept (e.g. /help): replies with gateway text, no Hermes', async () => {
    const fetchImpl = stubFetch();
    const binding = mockBinding({ thread_id: 'thr_x' });
    const client = mockClient();

    await makeHandleInbound()(binding, client)(validInbound('/help'));

    expect(client.sendText).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringMatching(/灵犀可用指令/),
    }));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dao.messages.insert).not.toHaveBeenCalled();
    expect(dao.threads.create).not.toHaveBeenCalled();
  });

  it('non-/new reject (e.g. /model): replies with reject text, no Hermes', async () => {
    const fetchImpl = stubFetch();
    const binding = mockBinding({ thread_id: 'thr_x' });
    const client = mockClient();

    await makeHandleInbound()(binding, client)(validInbound('/model claude'));

    expect(client.sendText).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringMatching(/模型由后端/),
    }));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dao.messages.insert).not.toHaveBeenCalled();
  });

  it('forward (unknown /<word>): falls through to normal dispatch', async () => {
    const fetchImpl = stubFetch(async () => new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    const binding = mockBinding({ thread_id: 'thr_x' });
    const client = mockClient();

    await makeHandleInbound()(binding, client)(validInbound('/some-unknown-skill arg'));
    await settle();

    // 走原流程 — 不建 thread (已有), 插 user msg (原文), 调 Hermes
    expect(dao.threads.create).not.toHaveBeenCalled();
    expect(dao.messages.insert).toHaveBeenCalledWith(expect.objectContaining({
      role: 'user', content: '/some-unknown-skill arg',
    }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    for (const [k] of wechatReplyContexts) wechatReplyContexts.delete(k);
  });

  it('sendText 失败 → console.error 不抛 (循环不杀)', async () => {
    const fetchImpl = stubFetch(async () => new Response('err', { status: 500 }));
    const client = {
      ...mockClient(),
      sendText: vi.fn(async () => { throw new Error('iLink down'); }),
    };
    await expect(makeHandleInbound()(mockBinding(), client as any)(validInbound()))
      .resolves.toBeUndefined();
    await settle();
  });

  it('slash /drop (无 args): 静默删旧 thread + 建新 thread + 回确认, 不派发', async () => {
    const fetchImpl = stubFetch(async () => new Response('{}', { status: 202 }));
    const client = mockClient();
    const binding = mockBinding({ thread_id: 'thr_old' });
    await makeHandleInbound()(binding, client)(validInbound('/drop'));
    await settle();
    expect(dropThreadSilently).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dropThreadSilently).mock.calls[0]![0]).toMatchObject({
      userId: 'u_alice', threadId: 'thr_old', source: 'wechat', containerUrl: 'http://container:8080',
    });
    expect(dao.threads.create).toHaveBeenCalledTimes(1);
    expect(dao.wechatBindings.bindThread).toHaveBeenCalledTimes(1);
    expect(binding.thread_id).not.toBe('thr_old');
    expect(client.sendText).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('slash /drop + args: 删旧 + 建新 + args 作为首条派发', async () => {
    const fetchImpl = stubFetch(async () => new Response('{}', { status: 202 }));
    const client = mockClient();
    await makeHandleInbound()(mockBinding({ thread_id: 'thr_old' }), client)(validInbound('/drop 继续聊'));
    await settle();
    expect(dropThreadSilently).toHaveBeenCalledTimes(1);
    expect(dao.threads.create).toHaveBeenCalledTimes(1);
    expect(dao.messages.insert).toHaveBeenCalledWith(expect.objectContaining({ role: 'user', content: '继续聊' }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    for (const [k] of wechatReplyContexts) wechatReplyContexts.delete(k);
  });
});

import { beforeEach } from 'vitest';
