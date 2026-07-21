/**
 * iLink CDN 流式拉取 + AES-128-ECB 流式解密。
 *
 * **不在 gateway 内存里缓冲完整文件**：返回一条 Web ReadableStream，调用方 (inbox-uploader)
 * 把它 pipe 到容器 `/inbox/{image,file}`。gateway 内存占用 ≈ 几个 16KB chunk，与文件大小无关。
 *
 * pipeline: fetch(CDN).body → sizeCounter(Transform) → createDecipheriv(aes-128-ecb)
 *   - sizeCounter 超 (maxBytes + PKCS7 余量) 主动 error，compose 把整条链路 destroy；
 *   - 解密用 Node 原生 Decipher，autoPadding 默认开，自动去 PKCS7；
 *   - AES key 优先按 hex 解，失败再 fallback base64，兼容 image_item 与 file_item 的编码。
 *
 * 字段名经真机抓包核实：下载 URL 使用 media.full_url（含 taskid）；不自行拼裸 encrypt_query_param。
 */
import { createDecipheriv } from 'node:crypto';
import { Readable, Transform } from 'node:stream';

/** 单一来源：图片 10 MiB，办公文件 25 MiB。uploader 把值透传为 X-Max-Bytes。 */
export const WECHAT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const WECHAT_FILE_MAX_BYTES = 25 * 1024 * 1024;

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

export interface EncryptedMediaPart {
  aes_key_hex: string;
  download_url: string;
  content_type_hint?: string;
  size_hint?: number;
}

export interface DecryptedMediaStream {
  body: ReadableStream<Uint8Array>;
  content_type: string;
  size_hint?: number;
}

export interface OpenStreamOpts {
  maxBytes: number;
}

/**
 * iLink 图片常给 16B hex / base64 原始 key；文件的 media.aes_key 则是 base64(hex 文本)。
 * 三种表达最终都必须还原为 AES-128 的 16B key。
 */
const decodeAesKey = (raw: string): Buffer => {
  if (/^[\da-f]{32}$/i.test(raw)) return Buffer.from(raw, 'hex');

  const base64 = Buffer.from(raw, 'base64');
  if (base64.length === AES_KEY_BYTES) return base64;

  const nestedHex = base64.toString('utf8');
  if (/^[\da-f]{32}$/i.test(nestedHex)) return Buffer.from(nestedHex, 'hex');

  throw new MediaDecryptError(
    `aes key not ${AES_KEY_BYTES} bytes (base64=${base64.length}, nested-hex=${nestedHex.length})`,
  );
};

/**
 * 打开一条 CDN → 解密 stream pipeline。调用方负责把 body pipe 到下游并消费。
 * size abort / 下载错 / 解密错 都会在 body 被消费时 reject。
 */
export async function openDecryptedMediaStream(
  part: EncryptedMediaPart,
  opts: OpenStreamOpts,
): Promise<DecryptedMediaStream> {
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
