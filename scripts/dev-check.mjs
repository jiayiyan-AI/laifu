#!/usr/bin/env node

// 跑 pnpm dev 之前的 prereq 自检。
//
// 用 Node 而非 shell: Windows 上 pnpm 经 cmd.exe 起脚本, cmd 跑不了 .sh
// (`'scripts' is not recognized as an internal or external command`)。
// 另外原 shell 用 lsof 查端口占用, Windows 没有该命令 —— 这里按平台分流到
// netstat -ano。同 scripts/dev-hermes.mjs 的取舍: spawn 不经 shell, 一份逻辑跑两端。

import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const IS_WIN = process.platform === 'win32';
const PG_CONTAINER = 'lingxi-pg-dev';
const PG_PORT = 54422;
const PORTS = [9001, 9000, 3000, PG_PORT];

const ok = (msg) => console.log(`  ✅ ${msg}`);
const warn = (msg) => console.log(`  ⚠️  ${msg}`);
const fail = (msg) => console.log(`  ❌ ${msg}`);

// 只要退出码; docker 未装时 'error' 分支返回 null (对齐 dev-hermes.mjs 的 run)。
function run(command, args) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.on('error', () => resolveRun(null));
    child.on('exit', (code) => resolveRun(code));
  });
}

// 要 stdout; 命令不存在或非零退出一律当空输出, 让调用方走 "查不到" 分支。
function capture(command, args) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', () => resolveRun(''));
    child.on('exit', (code) => resolveRun(code === 0 ? out : ''));
  });
}

const exists = (path) => access(resolve(ROOT, path)).then(() => true, () => false);

// 对齐 scripts/dev-hermes.mjs 的 parseEnvFile:
// 只取首次出现, 取第一个 = 之后的全部, 再删掉所有引号(不只是首尾)。
function parseEnvFile(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    if (values.has(key)) continue;
    values.set(key, raw.replaceAll(/["']/g, ''));
  }
  return values;
}

// 返回占用该端口的 pid (字符串), 空闲则 null。
// win: netstat -ano 里 state=LISTENING 且本地地址以 :port 结尾的行, 末列是 pid。
//      地址可能是 0.0.0.0:9000 / [::1]:9000 / 127.0.0.1:9000, 统一按后缀匹配。
//      ❗️不要加 -p tcp: Windows 的 -p TCP 只出 IPv4 (IPv6 要 -p TCPv6), 但协议列
//      两者都印 "TCP", 于是 vite/node 常见的 IPv6-only 监听 ([::1]:3000) 会被整行
//      滤掉, 端口明明被占却报 free。不加 -p 时 v4/v6 都在, 靠 cols[0] 认 TCP 即可。
// 其它: 沿用原 shell 的 lsof -ti。
async function portOwner(port) {
  if (IS_WIN) {
    const out = await capture('netstat', ['-ano']);
    for (const line of out.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 5 || cols[0] !== 'TCP' || cols[3] !== 'LISTENING') continue;
      if (cols[1].endsWith(`:${port}`)) return cols[4];
    }
    return null;
  }
  const out = await capture('lsof', ['-ti', `:${port}`]);
  return out.trim().split(/\r?\n/)[0] || null;
}

const killHint = (pid) => (IS_WIN ? `taskkill /PID ${pid} /T /F` : `kill -9 ${pid}`);

console.log('=== 灵犀 dev 环境自检 ===');
console.log('');

console.log('[Docker]');
const dockerUp = await run('docker', ['info']);
if (dockerUp === 0) ok('Docker Desktop 跑着');
else fail('Docker 没启,请先打开 Docker Desktop');

if ((await run('docker', ['image', 'inspect', 'hermes-probe'])) === 0) {
  ok('image hermes-probe 已 build');
} else {
  warn('image hermes-probe 未 build → docker build -t hermes-probe docker/hermes/');
}

console.log('');
console.log('[PostgreSQL 本地]');
const names = await capture('docker', ['ps', '--format', '{{.Names}}']);
if (names.split(/\r?\n/).some((n) => n.trim() === PG_CONTAINER)) {
  ok(`${PG_CONTAINER} 容器运行中 (port ${PG_PORT})`);
} else {
  warn('PG 未启 → ./scripts/dev-db.sh start');
}

console.log('');
console.log('[端口空闲]');
for (const port of PORTS) {
  const pid = await portOwner(port);
  if (!pid) {
    if (port === PG_PORT) warn(`port ${port} 空 (PG 应占着)`);
    else ok(`port ${port} free`);
  } else if (port === PG_PORT) {
    ok(`port ${port} 被 PG 占着 (pid ${pid})`);
  } else {
    warn(`port ${port} 被 ${pid} 占用 → ${killHint(pid)}`);
  }
}

console.log('');
console.log('[配置文件]');
if (await exists('apps/gateway/.env.local')) ok('apps/gateway/.env.local');
else fail('apps/gateway/.env.local 缺失');

if (await exists('docker/hermes/.env')) {
  const env = parseEnvFile(await readFile(resolve(ROOT, 'docker/hermes/.env'), 'utf8'));
  const provider = env.get('HERMES_PROVIDER') ?? '';
  const model = env.get('HERMES_MODEL') ?? '';
  const key = env.get('HERMES_API_KEY') ?? '';
  const baseUrl = env.get('HERMES_BASE_URL') ?? '';
  if (!provider || !model) {
    warn('docker/hermes/.env: HERMES_PROVIDER 或 HERMES_MODEL 未设');
  } else if (!key) {
    warn(`HERMES_PROVIDER=${provider} HERMES_MODEL=${model} 但 HERMES_API_KEY 空`);
  } else if (provider === 'custom' && !baseUrl) {
    warn('HERMES_PROVIDER=custom 但 HERMES_BASE_URL 空');
  } else {
    ok(`hermes: provider=${provider} model=${model}`);
  }
} else {
  warn('docker/hermes/.env 缺失 → cp docker/hermes/.env.example docker/hermes/.env 填 key');
}

console.log('');
console.log('如全 ✅,跑: pnpm dev');
