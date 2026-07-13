#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DESKTOP_PACKAGE = resolve(ROOT, 'apps/desktop/package.json');
const CARGO_TOML = resolve(ROOT, 'apps/desktop/src-tauri/Cargo.toml');
const TAURI_CONFIG = resolve(ROOT, 'apps/desktop/src-tauri/tauri.conf.json');
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function usage() {
  throw new Error('Usage: node scripts/desktop-version.mjs <check|current|set> [semver]');
}

function assertSemver(version) {
  if (!SEMVER.test(version)) {
    throw new Error(`Invalid desktop version: ${version}`);
  }
}

async function readVersions() {
  const [desktopPackageText, cargoToml, tauriConfigText] = await Promise.all([
    readFile(DESKTOP_PACKAGE, 'utf8'),
    readFile(CARGO_TOML, 'utf8'),
    readFile(TAURI_CONFIG, 'utf8'),
  ]);

  const desktopPackage = JSON.parse(desktopPackageText);
  const tauriConfig = JSON.parse(tauriConfigText);
  const cargoMatch = cargoToml.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m);
  if (!cargoMatch) throw new Error('Cargo.toml package version was not found');

  return {
    package: desktopPackage.version,
    cargo: cargoMatch[1],
    tauri: tauriConfig.version,
    cargoToml,
    desktopPackage,
    tauriConfig,
  };
}

async function checkVersion(expected) {
  assertSemver(expected);
  const versions = await readVersions();
  const mismatches = Object.entries({
    'apps/desktop/package.json': versions.package,
    'apps/desktop/src-tauri/Cargo.toml': versions.cargo,
    'apps/desktop/src-tauri/tauri.conf.json': versions.tauri,
  }).filter(([, actual]) => actual !== expected);

  if (mismatches.length > 0) {
    const details = mismatches.map(([file, actual]) => `${file}=${actual}`).join(', ');
    throw new Error(`Desktop version must be ${expected}; found ${details}`);
  }

  console.log(`[desktop-version] all desktop manifests are ${expected}`);
}
async function currentVersion() {
  const versions = await readVersions();
  const values = [versions.package, versions.cargo, versions.tauri];
  const uniqueVersions = new Set(values);
  if (uniqueVersions.size !== 1) {
    throw new Error(`Desktop manifest versions differ: ${values.join(', ')}`);
  }

  const [version] = uniqueVersions;
  assertSemver(version);
  console.log(version);
}


async function setVersion(version) {
  assertSemver(version);
  const versions = await readVersions();
  const updatedCargoToml = versions.cargoToml.replace(
    /^(\[package\][\s\S]*?^version\s*=\s*)"[^"]+"/m,
    `$1"${version}"`,
  );
  if (updatedCargoToml === versions.cargoToml) {
    throw new Error('Cargo.toml package version was not updated');
  }

  versions.desktopPackage.version = version;
  versions.tauriConfig.version = version;
  await Promise.all([
    writeFile(DESKTOP_PACKAGE, `${JSON.stringify(versions.desktopPackage, null, 2)}\n`),
    writeFile(CARGO_TOML, updatedCargoToml),
    writeFile(TAURI_CONFIG, `${JSON.stringify(versions.tauriConfig, null, 2)}\n`),
  ]);
  console.log(`[desktop-version] set all desktop manifests to ${version}`);
}

const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
const [command, version] = args;
if (!command || args.length > 2) usage();

if (command === 'check' && version && args.length === 2) {
  await checkVersion(version);
} else if (command === 'current' && args.length === 1) {
  await currentVersion();
} else if (command === 'set' && version && args.length === 2) {
  await setVersion(version);
} else {
  usage();
}
