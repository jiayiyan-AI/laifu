/**
 * 飞书消息资源 → streaming 拉取。
 *
 * 图片和文件都通过 `im.messageResource.get` 鉴权下载；gateway 不缓冲完整附件，只把受限
 * ReadableStream 转交容器 `/inbox/{image,file}`。
 */
import type * as Lark from '@larksuiteoapi/node-sdk';
import { Readable, Transform } from 'node:stream';

export const FEISHU_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const FEISHU_FILE_MAX_BYTES = 25 * 1024 * 1024;

export type FeishuResourceType = 'image' | 'file';

export class FeishuMediaTooLargeError extends Error {
  constructor(public actual: number, public limit: number) {
    super(`feishu media too large: ${actual} > ${limit}`);
    this.name = 'FeishuMediaTooLargeError';
  }
}

export class FeishuMediaDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeishuMediaDownloadError';
  }
}

export interface FeishuMediaStream {
  body: ReadableStream<Uint8Array>;
  content_type: string;
}

export interface OpenFeishuMediaOpts {
  maxBytes: number;
}

const extractContentType = (headers: unknown, fallback: string): string => {
  if (headers && typeof headers === 'object' && 'content-type' in headers) {
    const ct: unknown = headers['content-type'];
    if (typeof ct === 'string' && ct.length > 0) return ct.split(';')[0]!.trim();
  }
  return fallback;
};

/** 打开一条「飞书资源下载 → 限流」stream pipeline。 */
export async function openFeishuMediaStream(
  client: Lark.Client,
  messageId: string,
  resourceKey: string,
  resourceType: FeishuResourceType,
  opts: OpenFeishuMediaOpts,
): Promise<FeishuMediaStream> {
  const { maxBytes } = opts;

  let res: { getReadableStream: () => Readable; headers: unknown };
  try {
    res = await client.im.messageResource.get({
      path: { message_id: messageId, file_key: resourceKey },
      params: { type: resourceType },
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
    content_type: extractContentType(res.headers, resourceType === 'image' ? 'image/jpeg' : 'application/octet-stream'),
  };
}
