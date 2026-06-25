import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ContainerMapping } from '@lingxi/shared';

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

vi.mock('../../src/wechat-ilink/wechat-media-fetcher.js', () => {
  class MediaTooLargeError extends Error {
    constructor(public actual: number, public limit: number) {
      super('too large');
      this.name = 'MediaTooLargeError';
    }
  }
  return {
    WECHAT_IMAGE_MAX_BYTES: 10 * 1024 * 1024,
    MediaTooLargeError,
    openDecryptedImageStream: vi.fn(),
  };
});

vi.mock('../../src/lib/inbox-image-uploader.js', () => ({
  uploadImageStream: vi.fn(),
}));

vi.mock('../../src/lib/container-warm-cache.js', () => ({
  ensureContainerWarm: vi.fn(async () => {}),
  noteContainerActivity: vi.fn(),
}));

import { dao } from '../../src/db/index.js';
import {
  makeHandleInbound,
  wechatReplyContexts,
} from '../../src/wechat-ilink/inbound-handler.js';
import { buildInboxPrompt } from '../../src/lib/inbox-image-prompt.js';
import {
  openDecryptedImageStream,
  MediaTooLargeError,
} from '../../src/wechat-ilink/wechat-media-fetcher.js';
import { uploadImageStream } from '../../src/lib/inbox-image-uploader.js';
import { ensureContainerWarm } from '../../src/lib/container-warm-cache.js';
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
import { __resetPendingLoopsForTests } from '../../src/lib/pending-loops.js';

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
  thread_id: 'thr_existing',
  bound_at: '2026-06-01T00:00:00Z',
  ...overrides,
});

const mockClient = (): IlinkClient => ({
  getUpdates: vi.fn(),
  sendText: vi.fn(async () => {}),
});

const dispatch202 = () => {
  const f = vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 202 }));
  vi.stubGlobal('fetch', f as unknown as typeof fetch);
  return f;
};

const emptyStream = (): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({ start(c) { c.close(); } });

const imageItemObj = {
  aeskey: '87e0b2320ddbb8dee3804ec8b48203e1',
  media: { full_url: 'https://cdn.example/c2c/download?encrypted_query_param=blob&taskid=t1' },
};

const inboundWith = (items: unknown[]) => ({
  message_id: 'm1',
  message_type: 1,
  message_state: 0,
  from_user_id: 'wxid_friend',
  context_token: 'ctx',
  item_list: items,
});

const sentTexts = (client: IlinkClient): string[] =>
  vi.mocked(client.sendText).mock.calls.map((c) => c[0].text);

describe('handleInbound — image attachments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wechatReplyContexts.clear();
    vi.mocked(dao.cache.get).mockReturnValue({
      user_id: 'u_alice',
      status: 'ready',
      container_url: 'http://container:8080',
    } as unknown as ContainerMapping);
    vi.mocked(dao.usage.getBalance).mockResolvedValue({
      balance_cny: 10, free_quota_cny_month: 5, used_cny_month: 0, period_start: '2026-01-01',
    });
    vi.mocked(ensureContainerWarm).mockResolvedValue(undefined);
    vi.mocked(openDecryptedImageStream).mockResolvedValue({
      body: emptyStream(),
      content_type: 'image/jpeg',
    });
    vi.mocked(uploadImageStream).mockResolvedValue({
      cache_path: '/home/hermes/.hermes/cache/laifu-inbox/images/img_abc123.jpg',
      content_type: 'image/jpeg',
      size: 204_800,
    });
  });

  afterEach(() => {
    __resetThreadAggregatorForTests();
    __resetThreadSerializerForTests();
    __resetPendingLoopsForTests();
  });

  it('text + image: wakes container, uploads, inserts plain text message, dispatches prompt with path', async () => {
    const fetchImpl = dispatch202();
    const client = mockClient();
    const handle = makeHandleInbound()(mockBinding(), client);

    await handle(inboundWith([
      { type: 1, text_item: { text: '看看这张图' } },
      { type: 2, image_item: imageItemObj },
    ]));
    await settle();

    expect(ensureContainerWarm).toHaveBeenCalledWith('u_alice', 'http://container:8080');
    expect(uploadImageStream).toHaveBeenCalledTimes(1);

    const insertArg = vi.mocked(dao.messages.insert).mock.calls[0]![0];
    expect(insertArg.content_type).toBe('text');
    expect(insertArg.content).toBe('看看这张图');

    const chatCall = vi.mocked(fetchImpl).mock.calls.find((c) => String(c[0]).endsWith('/chat'));
    expect(chatCall).toBeDefined();
    const body = JSON.parse(String((chatCall![1] as { body: string }).body));
    expect(body.message).toContain('/home/hermes/.hermes/cache/laifu-inbox/images/img_abc123.jpg');
    expect(body.message).toContain('看看这张图');
  });

  it('image too large: sendText 过大, text still dispatched as plain text', async () => {
    vi.mocked(openDecryptedImageStream).mockRejectedValueOnce(new MediaTooLargeError(12_000_000, 10_485_760));
    const fetchImpl = dispatch202();
    const client = mockClient();
    const handle = makeHandleInbound()(mockBinding(), client);

    await handle(inboundWith([
      { type: 1, text_item: { text: '帮我看看' } },
      { type: 2, image_item: imageItemObj },
    ]));
    await settle();

    expect(sentTexts(client).some((t) => t.includes('图片过大'))).toBe(true);
    expect(uploadImageStream).not.toHaveBeenCalled();
    const insertArg = vi.mocked(dao.messages.insert).mock.calls[0]![0];
    expect(insertArg.content_type).toBe('text');
    expect(insertArg.content).toBe('帮我看看');
    expect(vi.mocked(fetchImpl).mock.calls.some((c) => String(c[0]).endsWith('/chat'))).toBe(true);
  });

  it('image-only too large: sendText 过大, no DB insert, no dispatch', async () => {
    vi.mocked(openDecryptedImageStream).mockRejectedValueOnce(new MediaTooLargeError(12_000_000, 10_485_760));
    const fetchImpl = dispatch202();
    const client = mockClient();
    const handle = makeHandleInbound()(mockBinding(), client);

    await handle(inboundWith([{ type: 2, image_item: imageItemObj }]));
    await settle();

    expect(sentTexts(client).some((t) => t.includes('图片过大'))).toBe(true);
    expect(dao.messages.insert).not.toHaveBeenCalled();
    expect(vi.mocked(fetchImpl).mock.calls.some((c) => String(c[0]).endsWith('/chat'))).toBe(false);
  });

  it('wake failure (image-only): 图全失败给反馈, no CDN open, no dispatch', async () => {
    vi.mocked(ensureContainerWarm).mockRejectedValueOnce(new Error('wake non-2xx: 503'));
    const fetchImpl = dispatch202();
    const client = mockClient();
    const handle = makeHandleInbound()(mockBinding(), client);

    await handle(inboundWith([{ type: 2, image_item: imageItemObj }]));
    await settle();

    // wake 失败 → fetchError; 纯图无文字 → 不 dispatch, 但给「图片处理失败」反馈(不再静默打水漂)
    expect(sentTexts(client).some((t) => t.includes('图片处理失败'))).toBe(true);
    expect(openDecryptedImageStream).not.toHaveBeenCalled();
    expect(uploadImageStream).not.toHaveBeenCalled();
    expect(vi.mocked(fetchImpl).mock.calls.some((c) => String(c[0]).endsWith('/chat'))).toBe(false);
  });

  it('unsupported part (voice) + text: sendText hint, then dispatch text', async () => {
    const fetchImpl = dispatch202();
    const client = mockClient();
    const handle = makeHandleInbound()(mockBinding(), client);

    await handle(inboundWith([
      { type: 1, text_item: { text: '你好' } },
      { type: 3 },
    ]));
    await settle();

    expect(sentTexts(client).some((t) => t.includes('语音消息暂不支持'))).toBe(true);
    expect(ensureContainerWarm).not.toHaveBeenCalled(); // 无图片 → 不 wake
    const chatCall = vi.mocked(fetchImpl).mock.calls.find((c) => String(c[0]).endsWith('/chat'));
    expect(chatCall).toBeDefined();
    expect(JSON.parse(String((chatCall![1] as { body: string }).body)).message).toBe('你好');
  });

  it('multiple images in one message upload serially and all land as attachments', async () => {
    vi.mocked(uploadImageStream)
      .mockResolvedValueOnce({ cache_path: '/c/img_1.jpg', content_type: 'image/jpeg', size: 1000 })
      .mockResolvedValueOnce({ cache_path: '/c/img_2.png', content_type: 'image/png', size: 2000 });
    const fetchImpl = dispatch202();
    const client = mockClient();
    const handle = makeHandleInbound()(mockBinding(), client);

    await handle(inboundWith([
      { type: 2, image_item: imageItemObj },
      { type: 2, image_item: imageItemObj },
    ]));
    await settle();

    expect(uploadImageStream).toHaveBeenCalledTimes(2);
    const insertArg = vi.mocked(dao.messages.insert).mock.calls[0]![0];
    expect(insertArg.content_type).toBe('text');
    expect(insertArg.content).toBe(''); // 纯图无文字 → 存空串
    // 两张图的路径都进了派发给 hermes 的 prompt
    const chatCall = vi.mocked(fetchImpl).mock.calls.find((c) => String(c[0]).endsWith('/chat'));
    const message = JSON.parse(String((chatCall![1] as { body: string }).body)).message;
    expect(message).toContain('/c/img_1.jpg');
    expect(message).toContain('/c/img_2.png');
  });

  it('超额用户发图: 配额闸提前拦, 不下载不上传不 dispatch', async () => {
    // 已用完且无余额
    vi.mocked(dao.usage.getBalance).mockResolvedValue({
      balance_cny: 0, free_quota_cny_month: 5, used_cny_month: 5, period_start: '2026-01-01',
    });
    const fetchImpl = dispatch202();
    const client = mockClient();
    const handle = makeHandleInbound()(mockBinding(), client);

    await handle(inboundWith([
      { type: 1, text_item: { text: '看图' } },
      { type: 2, image_item: imageItemObj },
    ]));
    await settle();

    expect(sentTexts(client).some((t) => t.includes('额度已用完'))).toBe(true);
    expect(ensureContainerWarm).not.toHaveBeenCalled();
    expect(openDecryptedImageStream).not.toHaveBeenCalled();
    expect(uploadImageStream).not.toHaveBeenCalled();
    expect(vi.mocked(fetchImpl).mock.calls.some((c) => String(c[0]).endsWith('/chat'))).toBe(false);
    expect(dao.messages.insert).not.toHaveBeenCalled();
  });
});
