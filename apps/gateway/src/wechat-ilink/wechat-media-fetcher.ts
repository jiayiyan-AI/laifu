/**
 * iLink CDN 流式拉取 + AES-128-ECB 流式解密。
 *
 * **不在 gateway 内存里缓冲完整文件**:返回一条 Web ReadableStream, 调用方 (inbox-uploader)
 * 把它 pipe 到容器 `/inbox/image`。gateway 内存占用 ≈ 几个 16KB chunk, 与文件大小无关。
 *
 * pipeline: fetch(CDN).body → sizeCounter(Transform) → createDecipheriv(aes-128-ecb)
 *   - sizeCounter 超 (maxBytes + PKCS7 余量) 主动 error, compose 把整条链路 destroy;
 *   - 解密用 Node 原生 Decipher, autoPadding 默认开, 自动去 PKCS7;
 *   - AES key 走 hex 解 (image_item.aeskey 是 16B 的 hex 文本), 失败再 fallback base64。
 *
 * 字段名经 2026-06-18 dev 真机抓包核实: key=image_item.aeskey(hex), url=image_item.media.full_url。
 * (旧版误用 media.aes_key=双重编码 + 拼 encrypt_query_param=缺 taskid, 见 weichat-file-impl.md 风险 #1/#2。)
 */
import { createDecipheriv } from 'node:crypto';
import { Readable, Transform } from 'node:stream';

/** 单一来源: 单图硬上限。uploader import 用作 X-Max-Bytes header 值, 不进 env。 */
export const WECHAT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

const CDN_FETCH_TIMEOUT_MS = 30_000;
// PKCS7 padding 最多补 16 字节, 给 sizeCounter 阈值留余量, 避免临界图被误判超限。
const PKCS7_PADDING_SLACK = 16;
const AES_KEY_BYTES = 16;

export class MediaTooLargeError extends Error {
  constructor(public readonly actual: number, public readonly limit: number) {
    super(`media too large: ${actual} > ${limit}`);
    this.name = 'MediaTooLargeError';
  }
}
export class MediaDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaDownloadError';
  }
}
export class MediaDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaDecryptError';
  }
}

export interface ImagePartInput {
  aes_key_hex: string;     // 16B key 的 hex 文本 (image_item.aeskey)
  download_url: string;    // 完整 CDN 下载 URL (image_item.media.full_url)
  content_type_hint?: string;
  size_hint?: number;
}

export interface DecryptedImageStream {
  body: ReadableStream<Uint8Array>;   // 已串好 sizeCounter + AES-128-ECB Decipher
  content_type: string;               // iLink hint, fallback 'image/jpeg' (§3.6)
  size_hint?: number;
}

export interface OpenStreamOpts {
  maxBytes: number;
}

/** hex 优先 (真实 key 是 hex 文本), 失败 fallback base64; 仍非 16 字节抛 MediaDecryptError。 */
const decodeAesKey = (raw: string): Buffer => {
  const hex = Buffer.from(raw, 'hex');
  if (hex.length === AES_KEY_BYTES) return hex;
  const b64 = Buffer.from(raw, 'base64');
  if (b64.length === AES_KEY_BYTES) return b64;
  throw new MediaDecryptError(
    `aes key not ${AES_KEY_BYTES} bytes (hex=${hex.length}, b64=${b64.length})`,
  );
};

/**
 * 打开一条 CDN → 解密 stream pipeline。调用方负责把 body pipe 到下游并消费。
 * size abort / 下载错 / 解密错 都会在 body 被消费时 reject。
 */
export async function openDecryptedImageStream(
  part: ImagePartInput,
  opts: OpenStreamOpts,
): Promise<DecryptedImageStream> {
  const { maxBytes } = opts;

  // 闸门 1: iLink 给了 size 且预判超限 → 根本不开 fetch
  if (part.size_hint !== undefined && part.size_hint > maxBytes) {
    throw new MediaTooLargeError(part.size_hint, maxBytes);
  }

  const key = decodeAesKey(part.aes_key_hex);

  const url = part.download_url;
  let resp: Response;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(CDN_FETCH_TIMEOUT_MS) });
  } catch (e) {
    throw new MediaDownloadError(`cdn fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!resp.ok) throw new MediaDownloadError(`cdn fetch non-2xx: ${resp.status}`);
  if (!resp.body) throw new MediaDownloadError('cdn response has no body');

  // 闸门 2: 流式累计字节, 超阈值主动 error → compose 把整条管道 destroy
  let count = 0;
  const sizeCounter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      count += chunk.length;
      if (count > maxBytes + PKCS7_PADDING_SLACK) {
        cb(new MediaTooLargeError(count, maxBytes));
        return;
      }
      cb(null, chunk);
    },
  });

  const decipher = createDecipheriv('aes-128-ecb', key, null);

  const cdnReadable = Readable.fromWeb(resp.body);
  cdnReadable.pipe(sizeCounter).pipe(decipher);

  // pipe 不转发 error: 任一上游 error (含 sizeCounter 的 MediaTooLargeError) 直接打到
  // decipher, consumer 读 body 时即 reject。
  const failDecipher = (err: Error): void => {
    if (!decipher.destroyed) decipher.destroy(err);
  };
  cdnReadable.once('error', failDecipher);
  sizeCounter.once('error', failDecipher);
  // consumer 取消 / decipher 收尾时, 上游一起 destroy 防 socket 泄漏。
  decipher.once('close', () => {
    if (!cdnReadable.destroyed) cdnReadable.destroy();
    if (!sizeCounter.destroyed) sizeCounter.destroy();
  });

  const body: ReadableStream<Uint8Array> = Readable.toWeb(decipher);

  return {
    body,
    content_type: part.content_type_hint || 'image/jpeg',
    size_hint: part.size_hint,
  };
}
