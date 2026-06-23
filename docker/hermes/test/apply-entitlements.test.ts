// apply-entitlements.test.ts — applyEntitlements 软链收敛单测 (bun test)。
// 给临时 skillsDir + sourceDir, 不碰真 HOME, 验证:
//   - desired 里 source 存在的建成软链并出现在 observed
//   - desired 里 source 不存在的跳过, 不进 observed
//   - 不在 desired 的 stale 软链被删
//   - 重复调用幂等 (observed 稳定, 软链不重复堆叠)
//   - skillsDir 不存在时自动 mkdir, 不抛

import { test, expect, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { lstatSync, readlinkSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { applyEntitlements } from '../scripts/sync-entitlements.ts';

let roots: string[] = [];
afterEach(async () => { for (const d of roots) await rm(d, { recursive: true, force: true }); roots = []; });

// 造一个 sourceDir(含若干已安装 skill 目录) + 空 skillsDir, 返回两者路径。
const makeDirs = async (installed: string[]): Promise<{ skillsDir: string; sourceDir: string }> => {
  const base = await mkdtemp(path.join(tmpdir(), 'hermes-apply-'));
  roots.push(base);
  const skillsDir = path.join(base, 'skills');
  const sourceDir = path.join(base, 'source');
  await mkdir(sourceDir, { recursive: true });
  for (const name of installed) {
    await mkdir(path.join(sourceDir, name), { recursive: true });
    await writeFile(path.join(sourceDir, name, 'SKILL.md'), 'x');
  }
  return { skillsDir, sourceDir };
};

test('links desired skills whose source exists, returns them as observed', async () => {
  const { skillsDir, sourceDir } = await makeDirs(['email', 'cloud']);
  const observed = applyEntitlements(['email', 'cloud'], skillsDir, sourceDir);
  expect(observed.sort()).toEqual(['cloud', 'email']);
  expect(lstatSync(path.join(skillsDir, 'email')).isSymbolicLink()).toBe(true);
  expect(readlinkSync(path.join(skillsDir, 'cloud'))).toBe(path.join(sourceDir, 'cloud'));
});

test('skips desired skill whose source is not installed', async () => {
  const { skillsDir, sourceDir } = await makeDirs(['email']);
  const observed = applyEntitlements(['email', 'ghost'], skillsDir, sourceDir);
  expect(observed).toEqual(['email']);
  expect(existsSync(path.join(skillsDir, 'ghost'))).toBe(false);
});

test('removes stale symlink no longer in desired', async () => {
  const { skillsDir, sourceDir } = await makeDirs(['email', 'cloud']);
  applyEntitlements(['email', 'cloud'], skillsDir, sourceDir);
  const observed = applyEntitlements(['email'], skillsDir, sourceDir);
  expect(observed).toEqual(['email']);
  expect(existsSync(path.join(skillsDir, 'cloud'))).toBe(false);
  expect(lstatSync(path.join(skillsDir, 'email')).isSymbolicLink()).toBe(true);
});

test('idempotent: repeated calls keep one symlink each, stable observed', async () => {
  const { skillsDir, sourceDir } = await makeDirs(['email']);
  applyEntitlements(['email'], skillsDir, sourceDir);
  const observed = applyEntitlements(['email'], skillsDir, sourceDir);
  expect(observed).toEqual(['email']);
  expect(readdirSync(skillsDir)).toEqual(['email']);
});

test('auto-mkdir skillsDir when absent, empty desired is no-op', async () => {
  const { skillsDir, sourceDir } = await makeDirs([]);
  const observed = applyEntitlements([], skillsDir, sourceDir);
  expect(observed).toEqual([]);
  expect(existsSync(skillsDir)).toBe(true);
});
