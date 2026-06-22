// inbox.test.ts — 容器侧 /inbox/image 落盘 + sweep 单测 (bun test)。
//
// 注: config.ts 在 import 时读 process.env.HOME 派生 IMAGE_CACHE_DIR, 所以必须在
// import server 模块**之前**把 HOME 指到临时目录。

import { test, expect, beforeEach, afterAll } from 'bun:test';
import { mkdtemp, rm, readdir, writeFile, stat, utimes, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HOME = await mkdtemp(path.join(tmpdir(), 'hermes-inbox-'));
process.env.HOME = HOME;
process.env.GATEWAY_SECRET = ''; // inbox handler 自身不校 bearer (http.handle 负责)

const { handleInboxImage, sweepOldFiles } = await import('../server/inbox.ts');
const { IMAGE_CACHE_DIR } = await import('../server/config.ts');

const makeRequest = (body: Uint8Array, headers: Record<string, string>): Request =>
  new Request('http://localhost/inbox/image', { method: 'POST', body, headers });

const listCache = async (): Promise<string[]> => {
  try {
    return await readdir(IMAGE_CACHE_DIR);
  } catch {
    return [];
  }
};

beforeEach(async () => {
  await rm(IMAGE_CACHE_DIR, { recursive: true, force: true });
});

afterAll(async () => {
  await rm(HOME, { recursive: true, force: true });
});

test('normal upload: writes final file, no .partial, returns path/size/content_type', async () => {
  const payload = new TextEncoder().encode('fake jpeg bytes here');
  const res = await handleInboxImage(
    makeRequest(payload, { 'content-type': 'image/jpeg', 'x-max-bytes': String(10 * 1024 * 1024) }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { path: string; size: number; content_type: string };
  expect(body.size).toBe(payload.length);
  expect(body.content_type).toBe('image/jpeg');
  expect(body.path.endsWith('.jpg')).toBe(true);
  expect(existsSync(body.path)).toBe(true);

  const files = await listCache();
  expect(files.some((f) => f.includes('.partial'))).toBe(false);
  expect(files.length).toBe(1);
});

// Smoke: 让请求真经过 Bun.serve (其余用例直接 handleInboxImage(new Request(...)), 走的是
// 缓冲态 body)。覆盖「服务端入站 web ReadableStream → 落盘 → 200」这条完整路径。
//
// 注意: 本用例**无法**确定性复现那个真正的生产 bug —— Bun 1.3.14 对入站 web stream 的
// 异步迭代实现仅在 *linux/amd64 + body 增量到达* (经 ACA Envoy / chunked socket) 时才坏。
// 同机 loopback 会把 body 合并成单块缓冲交付, 绕开坏路径; arm64 任何方式都不触发。
// 该 bug 的修复 (inbox.ts 用 Readable.fromWeb 绕开异步迭代) 已用生产镜像在 amd64 实测验证。
test('Bun.serve streaming inbound body: 200 + writes file (smoke)', async () => {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) => handleInboxImage(req),
  });
  try {
    const payload = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(payload); c.close(); },
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/inbox/image`, {
      method: 'POST',
      body,
      duplex: 'half', // streaming body 必需
      headers: { 'content-type': 'image/png', 'x-max-bytes': String(10 * 1024 * 1024) },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { size: number; path: string };
    expect(json.size).toBe(payload.length);
    expect(existsSync(json.path)).toBe(true);
  } finally {
    server.stop(true);
  }
});

test('content-type png → .png extension', async () => {
  const res = await handleInboxImage(
    makeRequest(new Uint8Array([1, 2, 3]), { 'content-type': 'image/png' }),
  );
  const body = (await res.json()) as { path: string };
  expect(body.path.endsWith('.png')).toBe(true);
});

test('body exceeds X-Max-Bytes → 500, no .partial, no final file', async () => {
  const payload = new Uint8Array(200).fill(7);
  const res = await handleInboxImage(
    makeRequest(payload, { 'content-type': 'image/jpeg', 'x-max-bytes': '10' }),
  );
  expect(res.status).toBe(500);
  const files = await listCache();
  expect(files.length).toBe(0); // .partial unlinked, final never created
});

test('sweepOldFiles: removes >7d files and orphan .partial, keeps fresh ones', async () => {
  await mkdir(IMAGE_CACHE_DIR, { recursive: true });
  const now = Date.now();
  const old = (days: number) => new Date(now - days * 86_400_000);
  const minsAgo = (m: number) => new Date(now - m * 60_000);

  const oldFile = path.join(IMAGE_CACHE_DIR, 'img_old.jpg');
  const freshFile = path.join(IMAGE_CACHE_DIR, 'img_fresh.jpg');
  const orphanPartial = path.join(IMAGE_CACHE_DIR, '.tmp-img_orphan.jpg.partial');
  const freshPartial = path.join(IMAGE_CACHE_DIR, '.tmp-img_inflight.jpg.partial');

  await writeFile(oldFile, 'x');
  await writeFile(freshFile, 'x');
  await writeFile(orphanPartial, 'x');
  await writeFile(freshPartial, 'x');

  await utimes(oldFile, old(8), old(8));
  await utimes(freshFile, old(1), old(1));
  await utimes(orphanPartial, minsAgo(6), minsAgo(6));
  await utimes(freshPartial, minsAgo(1), minsAgo(1));

  await sweepOldFiles(IMAGE_CACHE_DIR, 7 * 86_400_000);

  const files = await listCache();
  expect(files.sort()).toEqual(['.tmp-img_inflight.jpg.partial', 'img_fresh.jpg']);
});

test('sweepOldFiles on a missing dir is a no-op (no throw)', async () => {
  await rm(IMAGE_CACHE_DIR, { recursive: true, force: true });
  await expect(sweepOldFiles(IMAGE_CACHE_DIR, 7 * 86_400_000)).resolves.toBeUndefined();
});
