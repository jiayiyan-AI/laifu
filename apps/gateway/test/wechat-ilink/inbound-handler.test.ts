import { describe, it, expect, vi } from 'vitest';
import { makeHandleInbound } from '../../src/wechat-ilink/inbound-handler.js';
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
  const inserted: any[] = [];
  const threadBindings: Array<{ id: string; thread_id: string }> = [];
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
  const sb: any = {
    from: vi.fn(() => sb),
    insert: vi.fn((row: any) => { inserted.push(row); return Promise.resolve({ data: null, error: null }); }),
  };
  const cache = {
    get: vi.fn(() => ({
      user_id: 'u_alice',
      status: 'ready',
      container_url: 'http://container:8080',
    })),
  };
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ reply: '机器人答复' })));
  return {
    deps: { dao, sb, cache, fetchImpl, ...overrides },
    inserted, threadBindings,
  };
};

const mockClient = (): IlinkClient => ({
  getUpdates: vi.fn(),
  sendText: vi.fn(async () => {}),
});

describe('handleInbound', () => {
  it('happy path: 解析 → 建 thread → 调 hermes → sendText 回复', async () => {
    const { deps, inserted, threadBindings } = makeDeps();
    const client = mockClient();
    const handle = makeHandleInbound(deps as any)(mockBinding(), client);

    await handle(validInbound('hello'));

    // 建了 wechat thread
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      user_id: 'u_alice',
      source: 'wechat',
      title: '微信',
    });
    expect(threadBindings).toHaveLength(1);
    expect(threadBindings[0]!.id).toBe('bind_1');

    // 调 hermes
    expect(deps.fetchImpl).toHaveBeenCalledWith(
      'http://container:8080/chat',
      expect.objectContaining({ method: 'POST' }),
    );
    const callBody = JSON.parse((deps.fetchImpl as any).mock.calls[0]![1].body);
    expect(callBody.message).toBe('hello');
    expect(callBody.source).toBe('wechat');
    expect(callBody.session_id).toMatch(/^wechat:thr_/);

    // sendText 回复
    expect(client.sendText).toHaveBeenCalledWith({
      to_user_id: 'wxid_friend',
      text: '机器人答复',
      context_token: 'ctx_xyz',
    });
  });

  it('binding.thread_id 已存在 → 复用,不建新 thread', async () => {
    const { deps, inserted, threadBindings } = makeDeps();
    const binding = mockBinding({ thread_id: 'thr_existing' });
    const client = mockClient();

    await makeHandleInbound(deps as any)(binding, client)(validInbound());

    expect(inserted).toHaveLength(0);
    expect(threadBindings).toHaveLength(0);
    const callBody = JSON.parse((deps.fetchImpl as any).mock.calls[0]![1].body);
    expect(callBody.session_id).toBe('wechat:thr_existing');
  });

  it('connecte msg → 第二条复用 thread_id (in-memory 更新)', async () => {
    const { deps, inserted } = makeDeps();
    const binding = mockBinding();
    const client = mockClient();
    const handle = makeHandleInbound(deps as any)(binding, client);

    await handle(validInbound('one'));
    await handle(validInbound('two'));

    expect(inserted).toHaveLength(1);     // 第二条没再建 thread
    expect(deps.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('parseInbound 返 null → 静默 return,不调 hermes/sendText', async () => {
    const { deps } = makeDeps();
    const client = mockClient();
    const handle = makeHandleInbound(deps as any)(mockBinding(), client);

    // message_type=2 (bot echo)
    await handle({ ...validInbound(), message_type: 2 });

    expect(deps.fetchImpl).not.toHaveBeenCalled();
    expect(client.sendText).not.toHaveBeenCalled();
  });

  it('容器没 ready → 发兜底文案 + 不调 hermes', async () => {
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

  it('hermes 返非 2xx → 发兜底文案', async () => {
    const { deps } = makeDeps({
      fetchImpl: vi.fn(async () => new Response('err', { status: 502 })),
    });
    const client = mockClient();

    await makeHandleInbound(deps as any)(mockBinding(), client)(validInbound());

    expect(client.sendText).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringMatching(/失败|稍后/),
    }));
  });

  it('sendText 失败 → console.error 不抛 (循环不杀)', async () => {
    const { deps } = makeDeps();
    const client = {
      ...mockClient(),
      sendText: vi.fn(async () => { throw new Error('iLink down'); }),
    };
    await expect(makeHandleInbound(deps as any)(mockBinding(), client as any)(validInbound()))
      .resolves.toBeUndefined();
  });
});
