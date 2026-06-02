// gen-deploy-pkg.mjs — 生成 app-service-deploy/package.json
//
// 输入: apps/gateway/package.json (deps 清单) + pnpm-lock.yaml (精确版本)
// 输出: app-service-deploy/package.json
//
// 规则:
//   - 跳过 @lingxi/shared (已被 vite bundle inline 进 index.mjs)
//   - 跳过 devDependencies
//   - 跳过 scripts 里 dev/test/lint, 只留 start
//   - 加 main: index.mjs / engines.node: >=22

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const gwPkg = JSON.parse(readFileSync(resolve(ROOT, 'apps/gateway/package.json'), 'utf8'));

// 从 pnpm-lock 取 apps/gateway 锁定的精确版本。
// pnpm v9 lockfile 结构:
//   importers:
//     apps/gateway:
//       dependencies:
//         express:
//           specifier: ^4.19.0
//           version: 4.21.2
const parseLockfile = () => {
  const lock = readFileSync(resolve(ROOT, 'pnpm-lock.yaml'), 'utf8');
  const importerKey = '\n  apps/gateway:\n';
  const start = lock.indexOf(importerKey);
  if (start < 0) throw new Error('pnpm-lock.yaml: apps/gateway importer 没找到');
  // 找下一个 importer 行: 严格 "\n  <name>:\n" (2 空格缩进, 不能再多)
  const nextRe = /\n {2}[^ \n][^\n]*:\n/g;
  nextRe.lastIndex = start + importerKey.length;
  const m0 = nextRe.exec(lock);
  const nextImporter = m0 ? m0.index : -1;
  const block = nextImporter < 0 ? lock.slice(start) : lock.slice(start, nextImporter);

  const versions = {};
  // 形如 "      <name>:\n        specifier: ...\n        version: <ver>"
  // 带 / 的 scope 名 (@azure/x) 在 yaml 里会被单引号包起来; 普通名不会
  const re = /^      '?([@\w/.-]+)'?:\n        specifier: [^\n]+\n        version: (\S+)/gm;
  let m;
  while ((m = re.exec(block)) !== null) {
    versions[m[1]] = m[2].split('(')[0]; // 4.21.2(@types/foo@1.0.0) → 4.21.2
  }
  return versions;
};

const versions = parseLockfile();
console.log(`[gen-deploy-pkg] 从 pnpm-lock 解析到 ${Object.keys(versions).length} 个精确版本`);

const deps = {};
for (const name of Object.keys(gwPkg.dependencies ?? {})) {
  if (name === '@lingxi/shared') continue;
  const ver = versions[name];
  if (!ver) throw new Error(`pnpm-lock 缺失 dep 版本: ${name}`);
  deps[name] = ver;
}

const out = {
  name: gwPkg.name,
  version: gwPkg.version,
  private: true,
  type: 'module',
  main: 'index.mjs',
  engines: { node: '>=22' },
  scripts: { start: 'node index.mjs' },
  dependencies: deps,
};

const outPath = resolve(ROOT, 'app-service-deploy/package.json');
writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
console.log(`[gen-deploy-pkg] wrote ${outPath} (${Object.keys(deps).length} deps)`);
