#!/usr/bin/env node

import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BIN_DIR = resolve(ROOT, 'apps/desktop/src-tauri/binaries');
const RCLONE_VERSION = process.env.RCLONE_VERSION ?? 'v1.74.4';

const TARGETS = new Map([
  ['aarch64-apple-darwin', { os: 'osx', arch: 'arm64', extension: '' }],
  ['x86_64-apple-darwin', { os: 'osx', arch: 'amd64', extension: '' }],
  ['x86_64-pc-windows-msvc', { os: 'windows', arch: 'amd64', extension: '.exe' }],
]);

function usage() {
  throw new Error(
    'Usage: node scripts/fetch-rclone.mjs [--target <triple> | --universal-apple]',
  );
}

function hostTarget() {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'aarch64-apple-darwin';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'x86_64-apple-darwin';
  if (process.platform === 'win32' && process.arch === 'x64') return 'x86_64-pc-windows-msvc';

  throw new Error(`Unsupported host platform: ${process.platform}/${process.arch}`);
}

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      reject(new Error(`${command} exited with status ${code ?? 'unknown'}`));
    });
  });
}

async function findRclone(dir, filename) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name === filename) return path;
    if (entry.isDirectory()) {
      const found = await findRclone(path, filename);
      if (found) return found;
    }
  }
  return undefined;
}

async function extract(zip, destination) {
  if (process.platform === 'win32') {
    await run('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${zip.replaceAll("'", "''")}' -DestinationPath '${destination.replaceAll("'", "''")}' -Force`,
    ]);
    return;
  }

  await run('unzip', ['-q', '-o', zip, '-d', destination]);
}

async function fetchTarget(target) {
  const spec = TARGETS.get(target);
  if (!spec) throw new Error(`Unsupported rclone target: ${target}`);

  const zipName = `rclone-${RCLONE_VERSION}-${spec.os}-${spec.arch}.zip`;
  const url = `https://downloads.rclone.org/${RCLONE_VERSION}/${zipName}`;
  const temp = await mkdtemp(join(tmpdir(), 'laifu-rclone-'));

  try {
    const zip = join(temp, zipName);
    console.log(`[fetch-rclone] downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }

    await writeFile(zip, Buffer.from(await response.arrayBuffer()));
    await extract(zip, temp);

    const executable = `rclone${spec.extension}`;
    const source = await findRclone(temp, executable);
    if (!source) throw new Error(`${executable} was not found in ${zipName}`);

    await mkdir(BIN_DIR, { recursive: true });
    const destination = join(BIN_DIR, `rclone-${target}${spec.extension}`);
    await copyFile(source, destination);
    if (spec.extension === '') await chmod(destination, 0o755);
    console.log(`[fetch-rclone] installed ${basename(destination)}`);
    return destination;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function createUniversalAppleBinary() {
  if (process.platform !== 'darwin') {
    throw new Error('--universal-apple requires macOS because it invokes lipo');
  }

  const arm64 = await fetchTarget('aarch64-apple-darwin');
  const x64 = await fetchTarget('x86_64-apple-darwin');
  const universal = join(BIN_DIR, 'rclone-universal-apple-darwin');
  await run('lipo', ['-create', arm64, x64, '-output', universal]);
  await chmod(universal, 0o755);
  console.log(`[fetch-rclone] installed ${basename(universal)}`);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  await fetchTarget(hostTarget());
} else if (args.length === 1 && args[0] === '--universal-apple') {
  await createUniversalAppleBinary();
} else if (args.length === 2 && args[0] === '--target') {
  await fetchTarget(args[1]);
} else {
  usage();
}
