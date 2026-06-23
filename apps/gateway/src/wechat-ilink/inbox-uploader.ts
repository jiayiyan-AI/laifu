/**
 * gateway → 容器 `/inbox/image` 的 streaming uploader。
 *
 * 把 wechat-media-fetcher 打开的解密 stream 直接 POST 给容器, duplex:'half' 让 Node
 * fetch 以 ReadableStream 作为请求 body 流式上送, gateway 不持有完整文件。
 *
 * 不做应用层重试: streaming body 一旦消费就没了, 重试得从 fetcher 重新打开 CDN 连接,
 * 跨模块重试留到 inbound-handler 层 (P2)。
 */
import { getContainerToken } from '../lib/aca-call.js';
import { noteContainerActivity } from '../lib/container-warm-cache.js';
import { WECHAT_IMAGE_MAX_BYTES } from './wechat-media-fetcher.js';
import { log } from '../lib/logger.js';

const UPLOAD_TIMEOUT_MS = 60_000;

export interface UploadedAttachment {
  cache_path: string;
  content_type: string;
  size: number;
}

export interface UploadImageArgs {
  containerUrl: string;
  userId: string;                    // 内部用 getContainerToken(userId) 自取 Bearer
  body: ReadableStream<Uint8Array>;  // 来自 openDecryptedImageStream
  contentType: string;
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
        'X-Max-Bytes': String(WECHAT_IMAGE_MAX_BYTES),
        'X-Filename': args.filename ?? '',
      },
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    log.warn({ event: 'wechat.image.upload.failed', user_id: args.userId, status: 0, err });
    throw e instanceof Error ? e : new Error(err);
  }

  if (!resp.ok) {
    log.warn({ event: 'wechat.image.upload.failed', user_id: args.userId, status: resp.status, err: `http ${resp.status}` });
    throw new Error(`inbox upload failed: http ${resp.status}`);
  }

  const body = (await resp.json()) as InboxImageResponse;
  const uploadMs = Math.round(performance.now() - t0);
  log.info({
    event: 'wechat.image.upload.ok',
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
