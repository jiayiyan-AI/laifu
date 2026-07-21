/**
 * Tests for feishu/inbound-handler.ts 图片支持路径。
 *
 * mock 套路对标 wechat-ilink/inbound-handler-image.test.ts:
 *   - mock dao (mock-dao.js)
 *   - mock dispatchHermesChat (aca-call.js)
 *   - mock feishu-media-fetcher (openFeishuImageStream + FeishuMediaTooLargeError)
 *   - mock inbox-image-uploader (uploadImageStream)
 *   - mock container-warm-cache (ensureContainerWarm)
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

vi.mock('../../src/feishu/feishu-media-fetcher.js', () => {
  class FeishuMediaTooLargeError extends Error {
    constructor(public actual: number, public limit: number) {
      super('too large');
      this.name = 'FeishuMediaTooLargeError';
    }
  }
  return {
    FEISHU_IMAGE_MAX_BYTES: 10 * 1024 * 1024,
    FEISHU_FILE_MAX_BYTES: 25 * 1024 * 1024,
    FeishuMediaTooLargeError,
    openFeishuMediaStream: vi.fn(),
  };
});

vi.mock('../../src/lib/inbox-uploader.js', () => ({
  uploadInboxStream: vi.fn(),
}));

vi.mock('../../src/lib/container-warm-cache.js', () => ({
  ensureContainerWarm: vi.fn(async () => {}),
  noteContainerActivity: vi.fn(),
}));

import { dao } from '../../src/db/index.js';
import {
  makeFeishuInbound,
  feishuReplyContexts,
  __resetSeenForTests,
} from '../../src/feishu/inbound-handler.js';
import { __resetPendingLoopsForTests } from '../../src/lib/pending-loops.js';
import {
  openFeishuMediaStream,
  FeishuMediaTooLargeError,
} from '../../src/feishu/feishu-media-fetcher.js';
import { uploadInboxStream } from '../../src/lib/inbox-uploader.js';
import { ensureContainerWarm } from '../../src/lib/container-warm-cache.js';
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
  }) as never;

/** 构造一条飞书 image 消息事件。 */
const imageEvt = (opts: { messageId?: string; openId?: string; imageKey?: string } = {}) => ({
  sender: { sender_id: { open_id: opts.openId ?? OWNER } },
  message: {
    message_id: opts.messageId ?? 'img1',
    chat_id: 'oc_1',
    chat_type: 'p2p',
    message_type: 'image',
    content: JSON.stringify({ image_key: opts.imageKey ?? 'img_v2_abc' }),
  },
});

/** 构造一条飞书 post(图文混排) 消息事件。 */
const postEvt = (opts: { messageId?: string; text?: string; imageKeys?: string[] } = {}) => {
  const runs: Array<Record<string, string>> = [];
  if (opts.text) runs.push({ tag: 'text', text: opts.text });
  for (const k of opts.imageKeys ?? ['img_v2_p']) runs.push({ tag: 'img', image_key: k });
  return {
    sender: { sender_id: { open_id: OWNER } },
    message: {
      message_id: opts.messageId ?? 'post1',
      chat_id: 'oc_1',
      chat_type: 'p2p',
      message_type: 'post',
      content: JSON.stringify({ title: '', content: [runs] }),
    },
  };
};

const fakeStream = () =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array([1, 2, 3]));
      c.close();
    },
  });

describe('makeFeishuInbound — image', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    feishuReplyContexts.clear();
    __resetSeenForTests();
    __resetPendingLoopsForTests();
    dispatchHermesChat.mockResolvedValue({ ok: true, status: 202 } as never);
    vi.mocked(dao.cache.get).mockReturnValue({
      user_id: 'u_alice',
      status: 'ready',
      container_url: 'http://container:8080',
    } as never);
    vi.mocked(openFeishuMediaStream).mockResolvedValue({
      body: fakeStream(),
      content_type: 'image/jpeg',
    });
    vi.mocked(uploadInboxStream).mockResolvedValue({
      cache_path: '/home/hermes/.hermes/cache/laifu-inbox/images/img_xyz.jpg',
      content_type: 'image/jpeg',
      size: 204_800,
    });
  });

  it('owner 发图: wake 容器 → 下载 → 上传 → dispatch(prompt 含 cache_path), 入库 content 为 prompt', async () => {
    const client = mockClient();
    const handle = makeFeishuInbound()(mockBinding(), client);
    await handle(imageEvt({ imageKey: 'img_v2_abc' }));

    expect(ensureContainerWarm).toHaveBeenCalledWith('u_alice', 'http://container:8080');
    expect(openFeishuMediaStream).toHaveBeenCalledTimes(1);
    const fetchArgs = vi.mocked(openFeishuMediaStream).mock.calls[0]!;
    expect(fetchArgs[0]).toBe(client);
    expect(fetchArgs[1]).toBe('img1');       // messageId
    expect(fetchArgs[2]).toBe('img_v2_abc'); // imageKey
    expect(uploadInboxStream).toHaveBeenCalledTimes(1);
    expect(vi.mocked(uploadInboxStream).mock.calls[0]![0].channel).toBe('feishu');

    expect(dispatchHermesChat).toHaveBeenCalledTimes(1);
    const arg = dispatchHermesChat.mock.calls[0]![0] as { message: string; source: string };
    expect(arg.source).toBe('feishu');
    expect(arg.message).toContain('/home/hermes/.hermes/cache/laifu-inbox/images/img_xyz.jpg');

    const insertArg = vi.mocked(dao.messages.insert).mock.calls[0]![0];
    expect(insertArg.content).toContain('img_xyz.jpg');
    expect(feishuReplyContexts.size).toBe(1);
  });

  it('下载失败 → 不 dispatch, 回通用失败文案', async () => {
    vi.mocked(openFeishuMediaStream).mockRejectedValue(new Error('boom'));
    const client = mockClient();
    const handle = makeFeishuInbound()(mockBinding(), client);
    await handle(imageEvt({ messageId: 'img_fail' }));

    expect(dispatchHermesChat).not.toHaveBeenCalled();
    expect(client.im.message.create).toHaveBeenCalledTimes(1);
    expect(dao.messages.insert).not.toHaveBeenCalled();
  });

  it('图片过大 → 单独提示, 不 dispatch, 不发通用失败文案', async () => {
    vi.mocked(openFeishuMediaStream).mockRejectedValue(new FeishuMediaTooLargeError(20_000_000, 10_485_760));
    const client = mockClient();
    const handle = makeFeishuInbound()(mockBinding(), client);
    await handle(imageEvt({ messageId: 'img_big' }));

    expect(dispatchHermesChat).not.toHaveBeenCalled();
    // 太大文案发了一次(且仅一次, 没有再叠加通用失败)
    expect(client.im.message.create).toHaveBeenCalledTimes(1);
    expect(dao.messages.insert).not.toHaveBeenCalled();
  });

  it('容器未 ready → 提示并丢弃, 不下载不 dispatch', async () => {
    vi.mocked(dao.cache.get).mockReturnValue(undefined as never);
    const client = mockClient();
    const handle = makeFeishuInbound()(mockBinding(), client);
    await handle(imageEvt({ messageId: 'img_cold' }));

    expect(openFeishuMediaStream).not.toHaveBeenCalled();
    expect(dispatchHermesChat).not.toHaveBeenCalled();
    expect(client.im.message.create).toHaveBeenCalledTimes(1);
  });

  it('坏 content(缺 image_key) → 丢弃, 不下载不 dispatch', async () => {
    const client = mockClient();
    const handle = makeFeishuInbound()(mockBinding(), client);
    await handle({
      sender: { sender_id: { open_id: OWNER } },
      message: { message_id: 'img_bad', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'image', content: '{}' },
    });

    expect(openFeishuMediaStream).not.toHaveBeenCalled();
    expect(dispatchHermesChat).not.toHaveBeenCalled();
  });
  it('owner 发文件: 资源以 type=file 下载并保留文件名后派发', async () => {
    vi.mocked(openFeishuMediaStream).mockResolvedValue({ body: fakeStream(), content_type: 'application/pdf' });
    vi.mocked(uploadInboxStream).mockResolvedValue({
      cache_path: '/home/hermes/.hermes/cache/laifu-inbox/files/file_report.pdf',
      content_type: 'application/pdf',
      size: 20_480,
    });
    const client = mockClient();
    const handle = makeFeishuInbound()(mockBinding(), client);
    await handle({
      sender: { sender_id: { open_id: OWNER } },
      message: {
        message_id: 'file_1', chat_type: 'p2p', message_type: 'file',
        content: JSON.stringify({ file_key: 'file_v3_report', file_name: 'report.pdf' }),
      },
    });

    expect(vi.mocked(openFeishuMediaStream).mock.calls[0]!.slice(1, 4)).toEqual(['file_1', 'file_v3_report', 'file']);
    expect(vi.mocked(uploadInboxStream).mock.calls[0]![0]).toMatchObject({ kind: 'file', filename: 'report.pdf' });
    const message = (dispatchHermesChat.mock.calls[0]![0] as { message: string }).message;
    expect(message).toContain('file_report.pdf');
    expect(message).toContain('report.pdf');
  });
});

describe('makeFeishuInbound — post(图文混排)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    feishuReplyContexts.clear();
    __resetSeenForTests();
    __resetPendingLoopsForTests();
    dispatchHermesChat.mockResolvedValue({ ok: true, status: 202 } as never);
    vi.mocked(dao.cache.get).mockReturnValue({
      user_id: 'u_alice',
      status: 'ready',
      container_url: 'http://container:8080',
    } as never);
    vi.mocked(openFeishuMediaStream).mockImplementation(async () => ({
      body: fakeStream(),
      content_type: 'image/jpeg',
    }));
    vi.mocked(uploadInboxStream).mockResolvedValue({
      cache_path: '/home/hermes/.hermes/cache/laifu-inbox/images/img_post.jpg',
      content_type: 'image/jpeg',
      size: 102_400,
    });
  });

  it('图文混排: 文字 + 图都进 prompt, dispatch 被调', async () => {
    const client = mockClient();
    const handle = makeFeishuInbound()(mockBinding(), client);
    await handle(postEvt({ text: '看看这张图', imageKeys: ['img_v2_p'] }));

    expect(openFeishuMediaStream).toHaveBeenCalledTimes(1);
    expect(dispatchHermesChat).toHaveBeenCalledTimes(1);
    const arg = dispatchHermesChat.mock.calls[0]![0] as { message: string };
    expect(arg.message).toContain('看看这张图');
    expect(arg.message).toContain('img_post.jpg');
  });

  it('多图 post: 每个 image_key 各下载一次', async () => {
    const client = mockClient();
    const handle = makeFeishuInbound()(mockBinding(), client);
    await handle(postEvt({ messageId: 'post_multi', text: '两张图', imageKeys: ['img_a', 'img_b'] }));

    expect(openFeishuMediaStream).toHaveBeenCalledTimes(2);
    expect(vi.mocked(openFeishuMediaStream).mock.calls[0]![2]).toBe('img_a');
    expect(vi.mocked(openFeishuMediaStream).mock.calls[1]![2]).toBe('img_b');
    expect(dispatchHermesChat).toHaveBeenCalledTimes(1);
  });

  it('纯文字 post(无图) → 不下载, 按文本派发', async () => {
    const client = mockClient();
    const handle = makeFeishuInbound()(mockBinding(), client);
    await handle(postEvt({ messageId: 'post_txt', text: '只有文字', imageKeys: [] }));

    expect(openFeishuMediaStream).not.toHaveBeenCalled();
    expect(dispatchHermesChat).toHaveBeenCalledTimes(1);
    const arg = dispatchHermesChat.mock.calls[0]![0] as { message: string };
    expect(arg.message).toBe('只有文字');
  });
});
