import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  loadMemorySnapshot,
  mutateMemory,
  renderMemorySnapshot,
  resolveHermesMemoryPaths,
} from './memory-store.ts';

let roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

const makePaths = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hermes-memory-'));
  roots.push(root);
  const hermesHome = path.join(root, '.hermes');
  await mkdir(path.join(hermesHome, 'memories'), { recursive: true });
  return resolveHermesMemoryPaths(hermesHome);
};

test('loads SOUL, USER, and MEMORY into one frozen prompt block', async () => {
  const paths = await makePaths();
  await writeFile(paths.soul, 'Be concise.');
  await writeFile(paths.user, 'Prefers Chinese.');
  await writeFile(paths.memory, 'Uses Bun.');

  const prompt = renderMemorySnapshot(loadMemorySnapshot(paths));

  expect(prompt).toContain('## SOUL\nBe concise.');
  expect(prompt).toContain('## USER PROFILE\nPrefers Chinese.');
  expect(prompt).toContain('## MEMORY\nUses Bun.');
  expect(prompt).toContain('frozen snapshot');
});

test('adds entries without duplicates and persists Hermes entry separators', async () => {
  const paths = await makePaths();

  const first = mutateMemory(paths, { action: 'add', target: 'memory', content: 'Uses Bun.' });
  const duplicate = mutateMemory(paths, { action: 'add', target: 'memory', content: 'Uses Bun.' });
  const second = mutateMemory(paths, { action: 'add', target: 'memory', content: 'Uses TypeScript.' });

  expect(first.changed).toBe(true);
  expect(duplicate.changed).toBe(false);
  expect(second.entries).toEqual(['Uses Bun.', 'Uses TypeScript.']);
  expect(await readFile(paths.memory, 'utf8')).toBe('Uses Bun.\n\n§\n\nUses TypeScript.\n');
});

test('requires a unique oldText for replace and remove', async () => {
  const paths = await makePaths();
  await writeFile(paths.user, 'Prefers concise replies.\n\n§\n\nPrefers concise code.\n');

  expect(() => mutateMemory(paths, {
    action: 'replace', target: 'user', oldText: 'Prefers concise', content: 'Prefers detailed replies.',
  })).toThrow('Multiple memory entries');

  const replaced = mutateMemory(paths, {
    action: 'replace', target: 'user', oldText: 'concise replies', content: 'Prefers detailed replies.',
  });
  const removed = mutateMemory(paths, { action: 'remove', target: 'user', oldText: 'concise code' });

  expect(replaced.entries).toEqual(['Prefers detailed replies.', 'Prefers concise code.']);
  expect(removed.entries).toEqual(['Prefers detailed replies.']);
});

test('rejects mutations that exceed the Hermes character budget', async () => {
  const paths = await makePaths();

  expect(() => mutateMemory(paths, {
    action: 'add', target: 'user', content: 'x'.repeat(1_376),
  })).toThrow('1376/1375');
});
