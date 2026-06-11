import { describe, it, expect, vi } from 'vitest';
import { makeHandleInbound, wechatReplyContexts } from '../../src/wechat-ilink/inbound-handler.js';
import type { WechatBinding } from '../../src/db/wechat-binding-dao.js';
import type { IlinkClient } from '../../src/wechat-ilink/client.js';

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

const makeDeps = (overrides: any = {}) => {
  const created: any[] = [];
  const threadBindings: Array<{ id: string; thread_id: string }> = [];
  const insertedMsgs: any[] = [];
  const createdLoops: any[] = [];
  const dao = {
    listActive: vi.fn(),
    getByUserId: vi.fn(),
    upsertByUserId: vi.fn(),
    updateCursor: vi.fn(),
    bindThread: vi.fn(async (id: string, threadId: string) => {
      threadBindings.push({ id, thread_id: threadId });
    }),
    deactivate: vi.fn(),
  };
  const threadsDao = {
    create: vi.fn(async (row: any) => {
      created.push(row);
      return { ...row, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), archived: false };
    }),
    listByUser: vi.fn(),
    getByIdAndUser: vi.fn(),
    archive: vi.fn(),
  };
  const messageDao = {
    insert: vi.fn(async (msg: any) => { insertedMsgs.push(msg); }),
    listByThread: vi.fn(async () => []),
  };
  const agentLoopDao = {
    create: vi.fn(async (params: any) => { createdLoops.push(params); }),
    complete: vi.fn(async () => true),
    getById: vi.fn(async () => null),
    getActive: vi.fn(async () => null),
    reapStale: vi.fn(async () => 0),
  };
  const cache = {
    get: vi.fn(() => ({
      user_id: 'u_alice',
      status: 'ready',
      container_url: 'http://container:8080',
    })),
  };
  // dispatch 返回 202
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 202 }));
  return {
    deps: { dao, threadsDao, messageDao, agentLoopDao, cache, fetchImpl, ...overrides },
    created, threadBindings, insertedMsgs, createdLoops,
  };
};

const mockClient = (): IlinkClient => ({
  getUpdates: vi.fn(),
  sendText: vi.fn(async () => {}),
});

describe('handleInbound', () => {
  it('happy path: 解析 → 建 thread → 插消息 → 创建 loop → dispatch 202', async () => {
    const { deps, created, threadBindings, insertedMsgs, createdLoops } = makeDeps();
    const client = mockClient();
    const handle = makeHandleInbound(deps as any)(mockBinding(), client);

    await handle(validInbound('hello'));

    // 建了 wechat thread
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      user_id: 'u_alice',
      source: 'wechat',
      title: '微信',
    });
    expect(threadBindings).toHaveLength(1);

    // 插入 user 消息
    expect(insertedMsgs).toHaveLength(1);
    expect(insertedMsgs[0]).toMatchObject({
      role: 'user',
      content: 'hello',
      source: 'wechat',
    });

    // 创建 agent loop
    expect(createdLoops).toHaveLength(1);

    // 调 dispatch (异步模式带 callback 字段)
    expect(deps.fetchImpl).toHaveBeenCalledWith(
      'http://container:8080/chat',
      expect.objectContaining({ method: 'POST' }),
    );
    const callBody = JSON.parse((deps.fetchImpl as any).mock.calls[0]![1].body);
    expect(callBody.message).toBe('hello');
    expect(callBody.source).toBe('wechat');
    expect(callBody.session_id).toMatch(/^wechat:thr_/);
    expect(callBody.callback).toBeDefined();
    expect(callBody.callback.loop_id).toMatch(/^lp_/);

    // 回复上下文已存入 map
    const ctx = wechatReplyContexts.get(createdLoops[0].id);
    expect(ctx).toBeDefined();
    expect(ctx!.toUserId).toBe('wxid_friend');
    // 清理
    wechatReplyContexts.delete(createdLoops[0].id);
  });

  it('binding.thread_id 已存在 → 复用,不建新 thread', async () => {
    const { deps, created, threadBindings } = makeDeps();
    const binding = mockBinding({ thread_id: 'thr_existing' });
    const client = mockClient();

    await makeHandleInbound(deps as any)(binding, client)(validInbound());

    expect(created).toHaveLength(0);
    expect(threadBindings).toHaveLength(0);
    const callBody = JSON.parse((deps.fetchImpl as any).mock.calls[0]![1].body);
    expect(callBody.session_id).toBe('wechat:thr_existing');
    // 清理
    for (const [k] of wechatReplyContexts) wechatReplyContexts.delete(k);
  });

  it('第二条消息复用 thread_id (in-memory 更新)', async () => {
    const { deps, created } = makeDeps();
    const binding = mockBinding();
    const client = mockClient();
    const handle = makeHandleInbound(deps as any)(binding, client);

    await handle(validInbound('one'));
    await handle(validInbound('two'));

    expect(created).toHaveLength(1);     // 第二条没再建 thread
    expect(deps.fetchImpl).toHaveBeenCalledTimes(2);
    // 清理
    for (const [k] of wechatReplyContexts) wechatReplyContexts.delete(k);
  });

  it('parseInbound 返 null → 静默 return,不调 dispatch', async () => {
    const { deps } = makeDeps();
    const client = mockClient();
    const handle = makeHandleInbound(deps as any)(mockBinding(), client);

    // message_type=2 (bot echo)
    await handle({ ...validInbound(), message_type: 2 });

    expect(deps.fetchImpl).not.toHaveBeenCalled();
    expect(client.sendText).not.toHaveBeenCalled();
  });

  it('容器没 ready → 发兜底文案 + 不调 dispatch', async () => {
    const { deps } = makeDeps({
      cache: { get: vi.fn(() => null) },
    });
    const client = mockClient();
    const handle = makeHandleInbound(deps as any)(mockBinding(), client);

    await handle(validInbound());

    expect(deps.fetchImpl).not.toHaveBeenCalled();
    expect(client.sendText).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringMatching(/初始化|稍后/),
    }));
  });

  it('dispatch 返非 202 → complete loop fail + 发兜底文案', async () => {
    const { deps } = makeDeps({
      fetchImpl: vi.fn(async () => new Response('err', { status: 500 })),
    });
    const client = mockClient();

    await makeHandleInbound(deps as any)(mockBinding(), client)(validInbound());

    expect(deps.agentLoopDao.complete).toHaveBeenCalledWith(expect.any(String), 'fail');
    expect(client.sendText).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringMatching(/失败|稍后/),
    }));
  });

  it('sendText 失败 → console.error 不抛 (循环不杀)', async () => {
    const { deps } = makeDeps({
      // dispatch 失败路径触发 sendText
      fetchImpl: vi.fn(async () => new Response('err', { status: 500 })),
    });
    const client = {
      ...mockClient(),
      sendText: vi.fn(async () => { throw new Error('iLink down'); }),
    };
    await expect(makeHandleInbound(deps as any)(mockBinding(), client as any)(validInbound()))
      .resolves.toBeUndefined();
  });
});
