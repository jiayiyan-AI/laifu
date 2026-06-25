/**
 * gateway → 容器 `/inbox/image` 的 streaming uploader（渠道无关）。
 *
 * 把上游打开的图片 stream 直接 POST 给容器, duplex:'half' 让 Node fetch 以
 * ReadableStream 作为请求 body 流式上送, gateway 不持有完整文件。
 *
 * 微信/飞书共用: 微信走 CDN+AES 解密流, 飞书走 Lark resource API 流, 落到这里都是
 * 一条 Web ReadableStream + content_type + 渠道标识(仅用于日志埋点区分)。
 *
 * 不做应用层重试: streaming body 一旦消费就没了, 重试得从上游重新打开连接,
 * 跨模块重试留到各渠道 inbound-handler 层。
 */
import { getContainerToken } from './aca-call.js';
import { noteContainerActivity } from './container-warm-cache.js';
import { log } from './logger.js';
import { getTraceId } from './trace-context.js';

const UPLOAD_TIMEOUT_MS = 60_000;

export interface UploadedAttachment {
  cache_path: string;
  content_type: string;
  size: number;
}

export interface UploadImageArgs {
  containerUrl: string;
  userId: string;                    // 内部用 getContainerToken(userId) 自取 Bearer
  body: ReadableStream<Uint8Array>;  // 来自上游 fetcher 的解密/鉴权流
  contentType: string;
  maxBytes: number;                  // 容器侧硬上限提示 (X-Max-Bytes header)
  channel: 'wechat' | 'feishu';      // 仅日志埋点用, 区分渠道
  filename?: string;                 // 仅作日志 / X-Filename header
}

interface InboxImageResponse {
  path?: string;
  size?: number;
  content_type?: string;
}

export async function uploadImageStream(args: UploadImageArgs): Promise<UploadedAttachment> {
  const token = await getContainerToken(args.userId);
  const t0 = performance.now();

  let resp: Response;
  try {
    resp = await fetch(`${args.containerUrl}/inbox/image`, {
      method: 'POST',
      body: args.body,
      // Node 18.17+ fetch: ReadableStream body 必须声明 half-duplex
      duplex: 'half',
      headers: {
        'Content-Type': args.contentType,
        Authorization: `Bearer ${token}`,
        'X-Max-Bytes': String(args.maxBytes),
        'X-Filename': args.filename ?? '',
        ...(getTraceId() ? { 'X-Trace-Id': getTraceId()! } : {}),
      },
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    log.warn({ event: `${args.channel}.image.upload.failed`, user_id: args.userId, status: 0, err });
    throw e instanceof Error ? e : new Error(err);
  }

  if (!resp.ok) {
    log.warn({ event: `${args.channel}.image.upload.failed`, user_id: args.userId, status: resp.status, err: `http ${resp.status}` });
    throw new Error(`inbox upload failed: http ${resp.status}`);
  }

  const body = (await resp.json()) as InboxImageResponse;
  const uploadMs = Math.round(performance.now() - t0);
  log.info({
    event: `${args.channel}.image.upload.ok`,
    user_id: args.userId,
    size: body.size ?? 0,
    content_type: body.content_type ?? args.contentType,
    upload_ms: uploadMs,
  });
  noteContainerActivity(args.userId); // 200 = warm proof, 续 cache

  return {
    cache_path: body.path ?? '',
    content_type: body.content_type ?? args.contentType,
    size: body.size ?? 0,
  };
}
