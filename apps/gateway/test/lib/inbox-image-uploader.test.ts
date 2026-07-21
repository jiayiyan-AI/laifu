import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

import { uploadInboxStream } from '../../src/lib/inbox-uploader.js';

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

describe('uploadInboxStream', () => {
  it('POSTs a file to /inbox/file with bearer + headers + duplex, streams body, returns attachment', async () => {
    const payload = new TextEncoder().encode('PDF bytes');
    let seenUrl: string | URL | Request = '';
    let seenInit: RequestInit | undefined;
    let receivedLen = 0;

    vi.stubGlobal('fetch', (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = url;
      seenInit = init;
      const got = await drain(init?.body as ReadableStream<Uint8Array>);
      receivedLen = got.length;
      return Response.json({
        path: '/home/hermes/.hermes/cache/laifu-inbox/files/file_abc123def456_report.pdf',
        size: got.length,
        content_type: 'application/pdf',
      });
    }) as unknown as typeof fetch);

    const res = await uploadInboxStream({
      containerUrl: 'http://container.local',
      userId: 'u_alice',
      body: streamOf(payload),
      contentType: 'application/pdf',
      maxBytes: MAX_BYTES,
      kind: 'file',
      channel: 'wechat',
      filename: '预算报告.pdf',
    });

    expect(res).toEqual({
      cache_path: '/home/hermes/.hermes/cache/laifu-inbox/files/file_abc123def456_report.pdf',
      content_type: 'application/pdf',
      size: payload.length,
    });
    expect(receivedLen).toBe(payload.length);
    expect(seenUrl).toBe('http://container.local/inbox/file');
    expect(seenInit?.method).toBe('POST');
    // duplex 不在标准 RequestInit 类型里, 但 Node fetch 需要它
    expect((seenInit as { duplex?: string }).duplex).toBe('half');

    const headers = seenInit?.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Bearer .+/);
    expect(headers['X-Max-Bytes']).toBe(String(MAX_BYTES));
    expect(headers['Content-Type']).toBe('application/pdf');
    expect(headers['X-Filename']).toBe(encodeURIComponent('预算报告.pdf'));
  });

  it('keeps image uploads on /inbox/image without a filename', async () => {
    let seenUrl: string | URL | Request = '';
    let seenInit: RequestInit | undefined;
    vi.stubGlobal('fetch', (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = url;
      seenInit = init;
      return Response.json({
        path: '/home/hermes/.hermes/cache/laifu-inbox/images/img_abc123.jpg',
        size: 3,
        content_type: 'image/jpeg',
      });
    }) as unknown as typeof fetch);

    await uploadInboxStream({
      containerUrl: 'http://container.local',
      userId: 'u_alice',
      body: streamOf(new Uint8Array([1, 2, 3])),
      contentType: 'image/jpeg',
      maxBytes: MAX_BYTES,
      kind: 'image',
      channel: 'feishu',
    });

    expect(seenUrl).toBe('http://container.local/inbox/image');
    expect((seenInit?.headers as Record<string, string>)['X-Filename']).toBe('');
  });

  it('container 5xx → throws', async () => {
    vi.stubGlobal('fetch', (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch);
    await expect(
      uploadInboxStream({
        containerUrl: 'http://container.local',
        userId: 'u_alice',
        body: streamOf(new Uint8Array([1, 2, 3])),
        contentType: 'image/jpeg',
        maxBytes: MAX_BYTES,
        kind: 'image',
        channel: 'feishu',
      }),
    ).rejects.toThrow(/http 500/);
  });
});
