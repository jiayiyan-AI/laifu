import { describe, it, expect, vi } from 'vitest';
import { createCipheriv } from 'node:crypto';
import {
  openDecryptedImageStream,
  MediaTooLargeError,
  MediaDownloadError,
  MediaDecryptError,
} from '../../src/wechat-ilink/wechat-media-fetcher.js';

const KEY = Buffer.from('0123456789abcdef', 'utf8'); // 16 bytes

const encrypt = (plain: Buffer): Buffer => {
  const cipher = createCipheriv('aes-128-ecb', KEY, null);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
};

const drain = async (stream: ReadableStream<Uint8Array>): Promise<Buffer> => {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
};

// mock fetch 装到全局 (vitest unstubGlobals:true 每个测试后自动还原), 返回 spy 供断言。
const stubFetch = (cipher: Buffer): ReturnType<typeof vi.fn> => {
  const spy = vi.fn(async () => new Response(cipher));
  vi.stubGlobal('fetch', spy as unknown as typeof fetch);
  return spy;
};

describe('openDecryptedImageStream', () => {
  const URL = 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=blob&taskid=t1';

  it('round-trips: decrypts CDN cipher back to the original plaintext (hex key + full_url)', async () => {
    const plain = Buffer.from('微信图片字节内容 hello world '.repeat(40), 'utf8');
    const cipher = encrypt(plain);

    const spy = stubFetch(cipher);
    const res = await openDecryptedImageStream(
      { aes_key_hex: KEY.toString('hex'), download_url: URL },
      { maxBytes: 10 * 1024 * 1024 },
    );
    const out = await drain(res.body);
    expect(out.equals(plain)).toBe(true);
    expect(res.content_type).toBe('image/jpeg'); // 无 hint → fallback
    expect(spy).toHaveBeenCalledWith(URL, expect.anything()); // full_url 直接喂 fetch, 不再拼接
  });

  it('uses the content_type hint when provided', async () => {
    const cipher = encrypt(Buffer.from('x'));
    stubFetch(cipher);
    const res = await openDecryptedImageStream(
      { aes_key_hex: KEY.toString('hex'), download_url: URL, content_type_hint: 'image/png' },
      { maxBytes: 1024 },
    );
    await drain(res.body);
    expect(res.content_type).toBe('image/png');
  });

  it('aborts mid-stream with MediaTooLargeError when cipher exceeds the limit', async () => {
    const plain = Buffer.alloc(4096, 7);
    const cipher = encrypt(plain);
    stubFetch(cipher);
    const res = await openDecryptedImageStream(
      { aes_key_hex: KEY.toString('hex'), download_url: URL },
      { maxBytes: 1024 },   // 4KB cipher > 1KB limit
    );
    await expect(drain(res.body)).rejects.toBeInstanceOf(MediaTooLargeError);
  });

  it('falls back to base64 when aes_key is base64-encoded', async () => {
    const plain = Buffer.from('b64-keyed payload');
    const cipher = encrypt(plain);
    stubFetch(cipher);
    const res = await openDecryptedImageStream(
      { aes_key_hex: KEY.toString('base64'), download_url: URL }, // 非 hex → fallback base64
      { maxBytes: 1024 },
    );
    const out = await drain(res.body);
    expect(out.equals(plain)).toBe(true);
  });

  it('throws MediaDecryptError for an unparseable aes_key', async () => {
    stubFetch(Buffer.alloc(0));
    await expect(
      openDecryptedImageStream(
        { aes_key_hex: 'short', download_url: URL },
        { maxBytes: 1024 },
      ),
    ).rejects.toBeInstanceOf(MediaDecryptError);
  });

  it('pre-rejects oversized images via size_hint without opening fetch', async () => {
    const spy = stubFetch(Buffer.alloc(0));
    await expect(
      openDecryptedImageStream(
        { aes_key_hex: KEY.toString('hex'), download_url: URL, size_hint: 2048 },
        { maxBytes: 1024 },
      ),
    ).rejects.toBeInstanceOf(MediaTooLargeError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('throws MediaDownloadError on non-2xx CDN response', async () => {
    const spy = vi.fn(async () => new Response('nope', { status: 404 }));
    vi.stubGlobal('fetch', spy as unknown as typeof fetch);
    await expect(
      openDecryptedImageStream(
        { aes_key_hex: KEY.toString('hex'), download_url: URL },
        { maxBytes: 1024 },
      ),
    ).rejects.toBeInstanceOf(MediaDownloadError);
  });
});
