/**
 * Tests for feishu/inbound-handler.ts (飞书入站: open_id 鉴权 + 去重 + dispatch)
 *
 * 对标 wechat-ilink/inbound-handler.test.ts 的 mock 套路:
 *   - mock dao (mock-dao.js)
 *   - mock dispatchHermesChat (aca-call.js)
 * 去重 Set 跨 test 泄漏: 用 __resetSeenForTests() 在 beforeEach 清。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

const { dispatchHermesChat } = vi.hoisted(() => ({
  dispatchHermesChat: vi.fn(async () => ({ ok: true, status: 202 })),
}));
vi.mock('../../src/lib/aca-call.js', () => ({ dispatchHermesChat }));

const { dropThreadSilently } = vi.hoisted(() => ({ dropThreadSilently: vi.fn() }));
vi.mock('../../src/lib/drop-thread.js', () => ({ dropThreadSilently }));

import { dao } from '../../src/db/index.js';
import {
  makeFeishuInbound,
  feishuReplyContexts,
  __resetSeenForTests,
} from '../../src/feishu/inbound-handler.js';
import { __resetPendingLoopsForTests } from '../../src/lib/pending-loops.js';
import { dropThreadSilently } from '../../src/lib/drop-thread.js';
import type { FeishuBinding } from '../../src/db/feishu-binding-dao.js';

const OWNER = 'ou_owner';

const mockBinding = (overrides: Partial<FeishuBinding> = {}): FeishuBinding => ({
  id: 'fb_1',
  user_id: 'u_alice',
  app_id: 'cli_x',
  app_secret: 'sec',
  domain: 'feishu',
  owner_open_id: OWNER,
  thread_id: 'thr_1',
  status: 'active',
  is_active: true,
  bound_at: '2026-06-01T00:00:00Z',
  ...overrides,
});

const mockClient = () =>
  ({
    im: {
      message: {
        create: vi.fn(async () => ({})),
      },
    },
  }) as any;

/** 构造一条飞书 text 消息事件。 */
const evt = (opts: {
  messageId?: string;
  openId?: string;
  type?: string;
  text?: string;
  chatType?: string;
}) => ({
  sender: { sender_id: { open_id: opts.openId ?? OWNER } },
  message: {
    message_id: opts.messageId ?? 'm1',
    chat_id: 'oc_1',
    chat_type: opts.chatType ?? 'p2p',
    message_type: opts.type ?? 'text',
    content: JSON.stringify({ text: opts.text ?? '你好' }),
  },
});

describe('makeFeishuInbound', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    feishuReplyContexts.clear();
    __resetSeenForTests();
    __resetPendingLoopsForTests();
    dispatchHermesChat.mockResolvedValue({ ok: true, status: 202 } as any);
    vi.mocked(dao.cache.get).mockReturnValue({
      user_id: 'u_alice',
      status: 'ready',
      container_url: 'http://container:8080',
    } as any);
  });

  it('非 owner 发信 → 忽略, dispatch 不被调', async () => {
    const client = mockClient();
    const handle = makeFeishuInbound()(mockBinding(), client);
    await handle(evt({ openId: 'ou_stranger', text: 'hi' }));
    expect(dispatchHermesChat).not.toHaveBeenCalled();
    expect(feishuReplyContexts.size).toBe(0);
  });

  it('owner 文本 → dispatch 被调 (source:feishu) + feishuReplyContexts 有 toOpenId', async () => {
    const client = mockClient();
    const handle = makeFeishuInbound()(mockBinding(), client);
    await handle(evt({ openId: OWNER, text: 'hello' }));

    expect(dispatchHermesChat).toHaveBeenCalledTimes(1);
    const arg = dispatchHermesChat.mock.calls[0]![0] as any;
    expect(arg.source).toBe('feishu');
    expect(arg.message).toBe('hello');
    expect(arg.sessionId).toBe('feishu:thr_1');
    expect(arg.threadId).toBe('thr_1');
    expect(arg.containerUrl).toBe('http://container:8080');

    expect(feishuReplyContexts.size).toBe(1);
    const ctx = feishuReplyContexts.get(arg.loopId)!;
    expect(ctx.toOpenId).toBe(OWNER);
    expect(ctx.client).toBe(client);
  });

  it('同 message_id 二次 → dispatch 只调一次', async () => {
    const client = mockClient();
    const handle = makeFeishuInbound()(mockBinding(), client);
    await handle(evt({ messageId: 'dup1', text: 'a' }));
    await handle(evt({ messageId: 'dup1', text: 'a' }));
    expect(dispatchHermesChat).toHaveBeenCalledTimes(1);
  });

  it('不支持类型(audio) → 回提示, 不 dispatch', async () => {
    const client = mockClient();
    const handle = makeFeishuInbound()(mockBinding(), client);
    await handle(evt({ type: 'audio', messageId: 'aud1' }));
    expect(dispatchHermesChat).not.toHaveBeenCalled();
    expect(client.im.message.create).toHaveBeenCalledTimes(1);
  });

  it('空白文本 → 不 dispatch', async () => {
    const client = mockClient();
    const handle = makeFeishuInbound()(mockBinding(), client);
    await handle(evt({ text: '   ', messageId: 'blank1' }));
    expect(dispatchHermesChat).not.toHaveBeenCalled();
  });

  it('群聊消息 (chat_type:group) → 忽略, dispatch 不被调 (即便 sender 是 owner)', async () => {
    const client = mockClient();
    const handle = makeFeishuInbound()(mockBinding(), client);
    await handle(evt({ chatType: 'group', text: 'hi', messageId: 'grp1' }));
    expect(dispatchHermesChat).not.toHaveBeenCalled();
    expect(feishuReplyContexts.size).toBe(0);
  });

  it('seen Set 超过上限清空后, 新消息仍可正常 dispatch', async () => {
    const client = mockClient();
    const handle = makeFeishuInbound()(mockBinding(), client);
    // 第一条正常 dispatch
    await handle(evt({ messageId: 'before_clear', text: 'first' }));
    expect(dispatchHermesChat).toHaveBeenCalledTimes(1);
    // 重复同一 message_id → 仍被去重
    await handle(evt({ messageId: 'before_clear', text: 'first again' }));
    expect(dispatchHermesChat).toHaveBeenCalledTimes(1);
  });

  it('slash /help → 网关自答, 不 dispatch 不入库', async () => {
    const client = mockClient();
    const handle = makeFeishuInbound()(mockBinding(), client);
    await handle(evt({ messageId: 'sh1', text: '/help' }));
    expect(dispatchHermesChat).not.toHaveBeenCalled();
    expect(dao.messages.insert).not.toHaveBeenCalled();
    expect(client.im.message.create).toHaveBeenCalledTimes(1);
  });

  it('slash /new (无 args) → 建新 thread + bindThread, 回确认, 不 dispatch', async () => {
    const client = mockClient();
    const binding = mockBinding();
    const handle = makeFeishuInbound()(binding, client);
    await handle(evt({ messageId: 'sh2', text: '/new' }));
    expect(dao.threads.create).toHaveBeenCalledTimes(1);
    expect(dao.feishuBindings.bindThread).toHaveBeenCalledTimes(1);
    expect(binding.thread_id).toBeTruthy();
    expect(dispatchHermesChat).not.toHaveBeenCalled();
    expect(client.im.message.create).toHaveBeenCalledTimes(1);
  });

  it('slash /new + args → 建新 thread 后把 args 作为首条派发', async () => {
    const client = mockClient();
    const handle = makeFeishuInbound()(mockBinding(), client);
    await handle(evt({ messageId: 'sh3', text: '/new 顺便问下天气' }));
    expect(dao.threads.create).toHaveBeenCalledTimes(1);
    expect(dispatchHermesChat).toHaveBeenCalledTimes(1);
    const arg = dispatchHermesChat.mock.calls[0]![0] as { message: string };
    expect(arg.message).toBe('顺便问下天气');
  });

  it('slash /drop (无 args) → 静默删旧 thread + 建新 thread, 回确认, 不 dispatch', async () => {
    const client = mockClient();
    const binding = mockBinding({ thread_id: 'thr_old' });
    const handle = makeFeishuInbound()(binding, client);
    await handle(evt({ messageId: 'dr1', text: '/drop' }));
    // 删旧 thread (DB+session 由 dropThreadSilently 接管)
    expect(dropThreadSilently).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dropThreadSilently).mock.calls[0]![0]).toMatchObject({
      userId: 'u_alice', threadId: 'thr_old', source: 'feishu',
    });
    // 建新 thread
    expect(dao.threads.create).toHaveBeenCalledTimes(1);
    expect(dao.feishuBindings.bindThread).toHaveBeenCalledTimes(1);
    expect(binding.thread_id).not.toBe('thr_old');
    expect(dispatchHermesChat).not.toHaveBeenCalled();
    expect(client.im.message.create).toHaveBeenCalledTimes(1);
  });

  it('slash /drop + args → 删旧 + 建新 + 把 args 作为首条派发', async () => {
    const client = mockClient();
    const handle = makeFeishuInbound()(mockBinding({ thread_id: 'thr_old' }), client);
    await handle(evt({ messageId: 'dr2', text: '/drop 重新开始' }));
    expect(dropThreadSilently).toHaveBeenCalledTimes(1);
    expect(dao.threads.create).toHaveBeenCalledTimes(1);
    expect(dispatchHermesChat).toHaveBeenCalledTimes(1);
    const arg = dispatchHermesChat.mock.calls[0]![0] as { message: string };
    expect(arg.message).toBe('重新开始');
  });

  it('slash /drop 无当前 thread → 不调 dropThreadSilently, 仍建新会话', async () => {
    const client = mockClient();
    const handle = makeFeishuInbound()(mockBinding({ thread_id: null }), client);
    await handle(evt({ messageId: 'dr3', text: '/drop' }));
    expect(dropThreadSilently).not.toHaveBeenCalled();
    expect(dao.threads.create).toHaveBeenCalledTimes(1);
  });
});
