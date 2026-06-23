// sweep-cache.test.ts — 容器侧缓存 TTL 递归 sweep 单测 (bun test)。
//
// 直接喂临时目录给 sweepCacheTree(dir, ttlMs), 不碰真 HOME, 验证:
//   - 过期文件删, 新文件留
//   - 嵌套子目录里的过期文件也删, 删空后目录一并清掉
//   - 目录里只要还剩一个未过期文件, 该目录就保留
//   - 不存在的目录是 no-op 不抛

import { test, expect, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, utimes, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { sweepCacheTree } from '../scripts/sweep-cache.ts';

const DAY_MS = 86_400_000;
let roots: string[] = [];

const makeRoot = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hermes-sweep-'));
  roots.push(dir);
  return dir;
};

// 写文件并把 mtime 设到 ageDays 天前。
const writeAged = async (file: string, ageDays: number): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'x');
  const t = (Date.now() - ageDays * DAY_MS) / 1000;
  await utimes(file, t, t);
};

afterEach(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
  roots = [];
});

test('删过期文件, 留新文件', async () => {
  const root = await makeRoot();
  await writeAged(path.join(root, 'images/old.jpg'), 8);
  await writeAged(path.join(root, 'images/new.jpg'), 1);

  const res = await sweepCacheTree(root, 7 * DAY_MS);

  expect(res.files).toBe(1);
  expect(existsSync(path.join(root, 'images/old.jpg'))).toBe(false);
  expect(existsSync(path.join(root, 'images/new.jpg'))).toBe(true);
  // images/ 还有 new.jpg → 目录保留
  expect(existsSync(path.join(root, 'images'))).toBe(true);
});

test('嵌套全过期 → 文件删 + 空目录连带清掉', async () => {
  const root = await makeRoot();
  await writeAged(path.join(root, 'images/a.jpg'), 9);
  await writeAged(path.join(root, 'documents/sub/b.pdf'), 10);

  const res = await sweepCacheTree(root, 7 * DAY_MS);

  expect(res.files).toBe(2);
  expect(res.dirs).toBe(3); // images, documents/sub, documents
  expect(await readdir(root)).toEqual([]);
});

test('目录里有未过期文件 → 目录保留', async () => {
  const root = await makeRoot();
  await writeAged(path.join(root, 'images/old.jpg'), 8);
  await writeAged(path.join(root, 'images/keep.jpg'), 2);

  await sweepCacheTree(root, 7 * DAY_MS);

  expect(existsSync(path.join(root, 'images'))).toBe(true);
  expect(existsSync(path.join(root, 'images/keep.jpg'))).toBe(true);
});

test('不存在的目录是 no-op (不抛)', async () => {
  const res = await sweepCacheTree(path.join(tmpdir(), 'no-such-hermes-cache-xyz'), 7 * DAY_MS);
  expect(res).toEqual({ files: 0, dirs: 0 });
});
