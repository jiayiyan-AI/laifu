// inbox.ts — 接收 gateway streaming 上传的微信附件 (P1: 图片), 落到我们独占的 cache/laifu-inbox/images。
//
// 设计 (见 weichat-file-impl.md §Task 4):
//   - streaming 接收: pipeline(req.body 异步迭代 → cap 计数 → createWriteStream(.partial))
//   - EOF 正常 → rename(.partial → 正式名); 任何 abort/异常 → unlink(.partial)
//   - 落盘后 best-effort sweep: 清 TTL 过期文件 + 孤儿 .partial
//   - 二次大小防线: X-Max-Bytes header (gateway 单一源), 默认 10MB 兜底

import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { IMAGE_CACHE_DIR, INBOX_CACHE_TTL_DAYS } from './config.ts';
import { log } from './logger.ts';

const TTL_MS = INBOX_CACHE_TTL_DAYS * 86_400_000;
// gateway 没给 X-Max-Bytes 时的兜底上限 (正常 gateway 总会给, 这是防绕过)。
const HARD_MAX_BYTES_DEFAULT = 10 * 1024 * 1024;
// 孤儿 .partial 判定: 容器进程崩了留下的临时文件, 超此年龄即清。
const PARTIAL_ORPHAN_MS = 5 * 60_000;

const extForContentType = (ct: string): string => {
  if (ct.includes('png')) return '.png';
  if (ct.includes('webp')) return '.webp';
  if (ct.includes('gif')) return '.gif';
  if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg';
  return '.bin';
};

/** cap 计数的 streaming 中转: 超限抛错让 pipeline 把 write stream destroy。 */
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

export async function handleInboxImage(req: Request): Promise<Response> {
  if (!req.body) return Response.json({ error: 'empty body' }, { status: 400 });

  const contentType = (req.headers.get('content-type') ?? 'image/jpeg').split(';')[0]!.trim() || 'image/jpeg';
  const cap = Number(req.headers.get('x-max-bytes')) || HARD_MAX_BYTES_DEFAULT;

  const finalName = `img_${randomBytes(12).toString('hex')}${extForContentType(contentType)}`;
  const partialName = `.tmp-${finalName}.partial`;
  const finalPath = path.join(IMAGE_CACHE_DIR, finalName);
  const partialPath = path.join(IMAGE_CACHE_DIR, partialName);

  await mkdir(IMAGE_CACHE_DIR, { recursive: true });

  let bytes = 0;
  try {
    // Bun.serve 入站 req.body 是 web ReadableStream。Bun 1.3.14 (linux/amd64) 对它的
    // **异步迭代实现是坏的, 但只在 body 以真·增量流到达时触发** (经 ACA Envoy / chunked
    // socket, 分多次 socket read): 此时 `for await ... of req.body` 抛 "undefined is not
    // a function"。body 被合并成单块缓冲交付时 (同机 loopback / 小包) 则正常 —— 故这是个
    // 依赖交付时序的间歇 bug (生产 v13 偶发成功、v14 紧跟冷启动后必现, 同一份代码)。
    // getReader() 路径不受影响, 所以用 Readable.fromWeb 转 Node Readable 再喂 cappedBytes,
    // 彻底绕开坏掉的异步迭代。纯 new Request(...) 单测的 body 是缓冲态, 测不出此 bug,
    // 真起 Bun.serve + 增量 body 才能复现 (见 inbox.test.ts 回归用例)。
    await pipeline(
      cappedBytes(Readable.fromWeb(req.body as Parameters<typeof Readable.fromWeb>[0]), cap, (n) => { bytes = n; }),
      createWriteStream(partialPath),
    );
    await rename(partialPath, finalPath);
  } catch (e) {
    await unlink(partialPath).catch(() => {});
    const err = e instanceof Error ? e.message : String(e);
    log.error({ event: 'inbox.image.upload.failed', err, bytes });
    return Response.json({ error: err }, { status: 500 });
  }

  // best-effort sweep, 不阻塞响应
  sweepOldFiles(IMAGE_CACHE_DIR, TTL_MS).catch(() => {});

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
