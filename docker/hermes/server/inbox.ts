// inbox.ts — 接收 gateway streaming 上传的渠道附件，落到独占的 cache/laifu-inbox/{images,files}。
//
// 设计：
//   - streaming 接收：pipeline(req.body 异步迭代 → cap 计数 → createWriteStream(.partial))
//   - EOF 正常 → rename(.partial → 正式名)；任何 abort/异常 → unlink(.partial)
//   - 落盘后 best-effort sweep：清 TTL 过期文件 + 孤儿 .partial
//   - 二次大小防线：X-Max-Bytes header（gateway 单一源），默认 10MB 兜底

import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { FILE_CACHE_DIR, IMAGE_CACHE_DIR, INBOX_CACHE_TTL_DAYS } from './config.ts';
import { log } from './logger.ts';

const TTL_MS = INBOX_CACHE_TTL_DAYS * 86_400_000;
// gateway 没给 X-Max-Bytes 时的兜底上限（正常 gateway 总会给，这是防绕过）。
const HARD_MAX_BYTES_DEFAULT = 10 * 1024 * 1024;
// 孤儿 .partial 判定：容器进程崩了留下的临时文件，超此年龄即清。
const PARTIAL_ORPHAN_MS = 5 * 60_000;
// Linux 文件系统的单个路径组件通常限制为 255 UTF-8 字节；随机前缀也占用此预算。
const FILE_NAME_PREFIX = 'file_';
const FILE_NAME_RANDOM_HEX_LENGTH = 24;
const FILE_NAME_MAX_BYTES = 255 - Buffer.byteLength(`${FILE_NAME_PREFIX}${'0'.repeat(FILE_NAME_RANDOM_HEX_LENGTH)}_`);

const truncateUtf8 = (value: string, maxBytes: number): string => {
  if (Buffer.byteLength(value) <= maxBytes) return value;

  let result = '';
  let bytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char);
    if (bytes + charBytes > maxBytes) break;
    result += char;
    bytes += charBytes;
  }
  return result;
};

const safeFilename = (raw: string | null): string => {
  let decoded = raw ?? '';
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // 非法 percent-encoding 按原值处理；最终仍会清洗路径与控制字符。
  }
  const basename = path.basename(decoded).replace(/[\x00-\x1f]/g, '').trim();
  if (basename.length === 0) return 'file.bin';

  const extension = path.extname(basename);
  const stem = basename.slice(0, basename.length - extension.length);
  const truncatedExtension = truncateUtf8(extension, FILE_NAME_MAX_BYTES);
  const stemMaxBytes = FILE_NAME_MAX_BYTES - Buffer.byteLength(truncatedExtension);
  return `${truncateUtf8(stem, stemMaxBytes)}${truncatedExtension}`;
};

type InboxKind = 'image' | 'file';

const extForContentType = (ct: string): string => {
  if (ct.includes('png')) return '.png';
  if (ct.includes('webp')) return '.webp';
  if (ct.includes('gif')) return '.gif';
  if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg';
  return '.bin';
};


/** cap 计数的 streaming 中转：超限抛错让 pipeline 把 write stream destroy。 */
async function* cappedBytes(
  src: AsyncIterable<Uint8Array>,
  cap: number,
  onTotal: (n: number) => void,
): AsyncGenerator<Uint8Array> {
  let total = 0;
  for await (const chunk of src) {
    total += chunk.length;
    if (total > cap) throw new Error(`exceeds X-Max-Bytes (${cap})`);
    onTotal(total);
    yield chunk;
  }
}

export function handleInboxImage(req: Request): Promise<Response> {
  return handleInboxUpload(req, 'image');
}

export function handleInboxFile(req: Request): Promise<Response> {
  return handleInboxUpload(req, 'file');
}

async function handleInboxUpload(req: Request, kind: InboxKind): Promise<Response> {
  if (!req.body) return Response.json({ error: 'empty body' }, { status: 400 });

  const contentType = (req.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim() || 'application/octet-stream';
  const cap = Number(req.headers.get('x-max-bytes')) || HARD_MAX_BYTES_DEFAULT;
  const dir = kind === 'image' ? IMAGE_CACHE_DIR : FILE_CACHE_DIR;
  const finalName = kind === 'image'
    ? `img_${randomBytes(12).toString('hex')}${extForContentType(contentType)}`
    : `${FILE_NAME_PREFIX}${randomBytes(12).toString('hex')}_${safeFilename(req.headers.get('x-filename'))}`;
  const partialName = `.tmp-${finalName}.partial`;
  const finalPath = path.join(dir, finalName);
  const partialPath = path.join(dir, partialName);

  await mkdir(dir, { recursive: true });

  let bytes = 0;
  try {
    // Bun.serve 入站 req.body 的异步迭代在真正增量流到达时存在兼容问题；转为 Node Readable
    // 后交给 pipeline，避免缓冲整个文件。
    await pipeline(
      cappedBytes(Readable.fromWeb(req.body as Parameters<typeof Readable.fromWeb>[0]), cap, (n) => { bytes = n; }),
      createWriteStream(partialPath),
    );
    await rename(partialPath, finalPath);
  } catch (e) {
    await unlink(partialPath).catch(() => {});
    const err = e instanceof Error ? e.message : String(e);
    log.error({ event: `inbox.${kind}.upload.failed`, err, bytes });
    return Response.json({ error: err }, { status: 500 });
  }

  // best-effort sweep，不阻塞响应。
  sweepOldFiles(dir, TTL_MS).catch(() => {});

  return Response.json({ path: finalPath, size: bytes, content_type: contentType });
}

/** 清 dir 下: mtime 超 TTL 的正式文件 + mtime 超孤儿阈值的 .partial。全程吞错。 */
export async function sweepOldFiles(dir: string, ttlMs: number): Promise<void> {
  const now = Date.now();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return; // 目录还不存在 → 没东西可清
  }
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const st = await stat(full);
      if (!st.isFile()) continue;
      const age = now - st.mtimeMs;
      const isPartial = name.startsWith('.tmp-') && name.endsWith('.partial');
      if (age > ttlMs || (isPartial && age > PARTIAL_ORPHAN_MS)) {
        await unlink(full).catch(() => {});
      }
    } catch {
      // 文件可能被并发清掉, 忽略
    }
  }
}
