import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

import { uploadImageStream } from '../../src/lib/inbox-image-uploader.js';

const MAX_BYTES = 10 * 1024 * 1024;

const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });

const drain = async (s: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
  const reader = s.getReader();
  const chunks: number[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(...value);
  }
  return Uint8Array.from(chunks);
};

describe('uploadImageStream', () => {
  it('POSTs to /inbox/image with bearer + headers + duplex, streams body, returns attachment', async () => {
    const payload = new TextEncoder().encode('decrypted image bytes');
    let seenUrl: string | URL | Request = '';
    let seenInit: RequestInit | undefined;
    let receivedLen = 0;

    vi.stubGlobal('fetch', (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = url;
      seenInit = init;
      const got = await drain(init?.body as ReadableStream<Uint8Array>);
      receivedLen = got.length;
      return Response.json({
        path: '/home/hermes/.hermes/cache/laifu-inbox/images/img_abc123def456.jpg',
        size: got.length,
        content_type: 'image/jpeg',
      });
    }) as unknown as typeof fetch);

    const res = await uploadImageStream({
      containerUrl: 'http://container.local',
      userId: 'u_alice',
      body: streamOf(payload),
      contentType: 'image/jpeg',
      maxBytes: MAX_BYTES,
      channel: 'wechat',
      filename: 'photo.jpg',
    });

    expect(res).toEqual({
      cache_path: '/home/hermes/.hermes/cache/laifu-inbox/images/img_abc123def456.jpg',
      content_type: 'image/jpeg',
      size: payload.length,
    });
    expect(receivedLen).toBe(payload.length);
    expect(seenUrl).toBe('http://container.local/inbox/image');
    expect(seenInit?.method).toBe('POST');
    // duplex 不在标准 RequestInit 类型里, 但 Node fetch 需要它
    expect((seenInit as { duplex?: string }).duplex).toBe('half');

    const headers = seenInit?.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Bearer .+/);
    expect(headers['X-Max-Bytes']).toBe(String(MAX_BYTES));
    expect(headers['Content-Type']).toBe('image/jpeg');
    expect(headers['X-Filename']).toBe('photo.jpg');
  });

  it('container 5xx → throws', async () => {
    vi.stubGlobal('fetch', (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch);
    await expect(
      uploadImageStream({
        containerUrl: 'http://container.local',
        userId: 'u_alice',
        body: streamOf(new Uint8Array([1, 2, 3])),
        contentType: 'image/jpeg',
        maxBytes: MAX_BYTES,
        channel: 'feishu',
      }),
    ).rejects.toThrow(/http 500/);
  });
});
