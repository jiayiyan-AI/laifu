/**
 * gateway → 容器 `/inbox/{image,file}` 的 streaming uploader（渠道无关）。
 *
 * 上游下载流直接 POST 给容器；gateway 不持有完整附件。重试必须从上游重开流，
 * 因此由各渠道的 inbound handler 决定是否重试。
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

export interface UploadInboxStreamArgs {
  containerUrl: string;
  userId: string;
  body: ReadableStream<Uint8Array>;
  contentType: string;
  maxBytes: number;
  kind: 'image' | 'file';
  channel: 'wechat' | 'feishu';
  filename?: string;
}

interface InboxUploadResponse {
  path?: string;
  size?: number;
  content_type?: string;
}

export async function uploadInboxStream(args: UploadInboxStreamArgs): Promise<UploadedAttachment> {
  const token = await getContainerToken(args.userId);
  const t0 = performance.now();

  let response: Response;
  try {
    response = await fetch(`${args.containerUrl}/inbox/${args.kind}`, {
      method: 'POST',
      body: args.body,
      // Node 18.17+ fetch: ReadableStream body 必须声明 half-duplex。
      duplex: 'half',
      headers: {
        'Content-Type': args.contentType,
        Authorization: `Bearer ${token}`,
        'X-Max-Bytes': String(args.maxBytes),
        // HTTP header values are byte-oriented; percent-encode UTF-8 filenames so Chinese and other Unicode names survive transport.
        'X-Filename': args.filename ? encodeURIComponent(args.filename) : '',
        ...(getTraceId() ? { 'X-Trace-Id': getTraceId()! } : {}),
      },
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    log.warn({ event: `${args.channel}.${args.kind}.upload.failed`, user_id: args.userId, status: 0, err });
    throw e instanceof Error ? e : new Error(err);
  }

  if (!response.ok) {
    log.warn({ event: `${args.channel}.${args.kind}.upload.failed`, user_id: args.userId, status: response.status, err: `http ${response.status}` });
    throw new Error(`inbox upload failed: http ${response.status}`);
  }

  const body = (await response.json()) as InboxUploadResponse;
  log.info({
    event: `${args.channel}.${args.kind}.upload.ok`,
    user_id: args.userId,
    size: body.size ?? 0,
    content_type: body.content_type ?? args.contentType,
    upload_ms: Math.round(performance.now() - t0),
  });
  noteContainerActivity(args.userId);

  return {
    cache_path: body.path ?? '',
    content_type: body.content_type ?? args.contentType,
    size: body.size ?? 0,
  };
}
