/**
 * 飞书消息图片资源 → streaming 拉取。
 *
 * 与微信不同, 飞书图片不是 CDN 外链 + AES, 而是消息内 `image_key`, 走 Lark Open API
 * `im.messageResource.get`(鉴权下载, tenant_access_token 由 SDK Client 自动注入)。
 * 因此**无需解密**, 也没有 CDN TTL 的紧迫性(资源随消息长期可取, 只要 bot 在会话内)。
 *
 * pipeline: SDK getReadableStream()(Node Readable) → sizeCounter(Transform 限 maxBytes) → toWeb
 *   - 不在 gateway 内存缓冲整文件: 返回 Web ReadableStream, 调用方 pipe 到容器 /inbox/image;
 *   - sizeCounter 超阈值主动 error → 上游一起 destroy, consumer 读 body 时 reject;
 *   - content_type 取响应头 content-type, 缺则 fallback image/jpeg。
 *
 * 前提: 飞书自建应用需开通 `im:resource`(读取消息中资源文件)权限, 且 bot 与消息在同一会话。
 */
import type * as Lark from '@larksuiteoapi/node-sdk';
import { Readable, Transform } from 'node:stream';

/** 单图硬上限。与微信 10MB 对齐(飞书 API 上限 100M, 我们自设更紧的闸)。 */
export const FEISHU_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

export class FeishuMediaTooLargeError extends Error {
  constructor(public actual: number, public limit: number) {
    super(`feishu image too large: ${actual} > ${limit}`);
    this.name = 'FeishuMediaTooLargeError';
  }
}

export class FeishuMediaDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeishuMediaDownloadError';
  }
}

export interface FeishuImageStream {
  /** Web ReadableStream, 供 uploader 流式 POST 给容器。 */
  body: ReadableStream<Uint8Array>;
  /** 图片 MIME, 缺省 image/jpeg。 */
  content_type: string;
}

export interface OpenFeishuImageOpts {
  maxBytes: number;
}

/** axios headers 是普通对象, 安全提取 content-type(走 narrowing, 不内联 cast)。 */
const extractContentType = (headers: unknown): string => {
  if (headers && typeof headers === 'object' && 'content-type' in headers) {
    const ct: unknown = headers['content-type'];
    if (typeof ct === 'string' && ct.length > 0) return ct.split(';')[0]!.trim();
  }
  return 'image/jpeg';
};

/**
 * 打开一条「飞书资源下载 → 限流」stream pipeline。调用方负责把 body pipe 到下游并消费。
 * size abort / 下载错都会在 body 被消费时 reject。
 */
export async function openFeishuImageStream(
  client: Lark.Client,
  messageId: string,
  imageKey: string,
  opts: OpenFeishuImageOpts,
): Promise<FeishuImageStream> {
  const { maxBytes } = opts;

  let res: { getReadableStream: () => Readable; headers: unknown };
  try {
    res = await client.im.messageResource.get({
      path: { message_id: messageId, file_key: imageKey },
      params: { type: 'image' },
    });
  } catch (e) {
    throw new FeishuMediaDownloadError(
      `feishu resource fetch failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const source = res.getReadableStream();

  // 流式累计字节, 超阈值主动 error → 把整条管道 destroy。
  let count = 0;
  const sizeCounter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      count += chunk.length;
      if (count > maxBytes) {
        cb(new FeishuMediaTooLargeError(count, maxBytes));
        return;
      }
      cb(null, chunk);
    },
  });

  source.pipe(sizeCounter);

  // pipe 不转发 error: 上游 error 直接打到 sizeCounter, consumer 读 body 时 reject。
  source.once('error', (err: Error) => {
    if (!sizeCounter.destroyed) sizeCounter.destroy(err);
  });
  // consumer 取消 / 收尾时, 上游一起 destroy 防 socket 泄漏。
  sizeCounter.once('close', () => {
    if (!source.destroyed) source.destroy();
  });

  const body = Readable.toWeb(sizeCounter) as ReadableStream<Uint8Array>;

  return {
    body,
    content_type: extractContentType(res.headers),
  };
}
