#!/usr/bin/env node

// 启动本地 Hermes container,被 pnpm dev 调用。
// 终止时(Ctrl+C / concurrently kill)清掉容器。
//
// 用 Node 而非 shell: Windows 上 cmd.exe 跑不了 .sh, 而让 Git Bash 跑又会撞上
// MSYS 路径转换 —— 它会把 -v 右侧的容器内路径 /home/hermes 改写成宿主机路径。
// Node 的 spawn 不经 shell, 参数原样传给 docker, Mac/Windows 同一份逻辑。

import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ENV_FILE = resolve(ROOT, 'docker/hermes/.env');
const IMAGE = 'hermes-probe';
const CONTAINER_NAME = 'lingxi-hermes-dev';
const HOME_VOL = join(homedir(), '.hermes-dev');

const KEY_HELP = new Map([
  ['anthropic', '   申请: https://console.anthropic.com/settings/keys'],
  ['alibaba', '   申请: https://dashscope.console.aliyun.com/'],
  ['custom', '   custom provider 需要对应端点的 API key'],
]);

function fail(...lines) {
  for (const line of lines) console.error(line);
  process.exit(1);
}

// 对齐原 shell 的 read_env: grep "^KEY=" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'"
// 即 —— 只取首次出现,取第一个 = 之后的全部,再删掉所有引号(不只是首尾)。
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

// stdio: 'ignore' 对齐原 shell 的 >/dev/null 2>&1
function run(command, args, { stdio = 'ignore' } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { stdio });
    child.on('error', () => resolveRun(null));
    child.on('exit', (code) => resolveRun(code));
  });
}

async function readEnv() {
  let text;
  try {
    text = await readFile(ENV_FILE, 'utf8');
  } catch {
    fail(
      `⚠️  ${ENV_FILE} 不存在`,
      '   先复制模板:  cp docker/hermes/.env.example docker/hermes/.env',
      '   然后填 HERMES_API_KEY (按 HERMES_PROVIDER 选对应 provider 的 key)',
    );
  }
  return parseEnvFile(text);
}

const env = await readEnv();
const provider = env.get('HERMES_PROVIDER') ?? '';
const model = env.get('HERMES_MODEL') ?? '';
const apiKey = env.get('HERMES_API_KEY') ?? '';
const baseUrl = env.get('HERMES_BASE_URL') ?? '';

if (!provider || !model) {
  fail(`⚠️  ${ENV_FILE} 缺 HERMES_PROVIDER 或 HERMES_MODEL`);
}
if (!apiKey) {
  const help = KEY_HELP.get(provider);
  fail(`⚠️  HERMES_API_KEY 未设 (provider=${provider})`, ...(help ? [help] : []));
}
if (provider === 'custom' && !baseUrl) {
  fail('⚠️  HERMES_PROVIDER=custom 必须设 HERMES_BASE_URL');
}
console.log(`ℹ️  hermes provider=${provider} model=${model}`);

// docker 没装 / 没启动时 run() 的 'error' 分支返回 null,给条明确提示而不是让 spawn 报错。
const inspected = await run('docker', ['image', 'inspect', IMAGE]);
if (inspected === null) {
  fail('⚠️  docker 命令不可用,先装 Docker Desktop 并确认它已启动');
}
if (inspected !== 0) {
  fail(
    `⚠️  image '${IMAGE}' 不存在,需要先 build:`,
    `     docker build -t ${IMAGE} docker/hermes/`,
    '   (首次约 10-15 分钟,之后改 server/*.ts 增量约 20 秒)',
  );
}

// 清掉同名残留(上一次没 graceful 停掉)
await run('docker', ['rm', '-f', CONTAINER_NAME]);
await mkdir(HOME_VOL, { recursive: true });

// --rm: 退出自动删
// --name: 固定名字,方便外部停掉
// --add-host: 让容器内 host.docker.internal 解析到 host (Linux Docker 没自动设,Mac/Win 自带)
// -e GATEWAY_BASE_URL: entrypoint 调 /api/me/entitlements 等控制面端点用
//                       host.docker.internal:9000 = host 上跑的 gateway
// 把日志直接打到当前 stdout (concurrently 会接收并加前缀)
const container = spawn(
  'docker',
  [
    'run',
    '--rm',
    '--name', CONTAINER_NAME,
    '-p', '9001:8080',
    '-v', `${HOME_VOL}:/home/hermes`,
    '--add-host=host.docker.internal:host-gateway',
    '-e', 'GATEWAY_BASE_URL=http://host.docker.internal:9000',
    '--env-file', ENV_FILE,
    IMAGE,
  ],
  { stdio: 'inherit' },
);

// 原 shell 靠 trap cleanup EXIT INT TERM。这里显式停容器:Windows 上 concurrently
// 用 taskkill 收尸, docker run 未必收得到信号, 不主动 stop 会留下孤儿容器。
let stopping = false;
async function cleanup() {
  if (stopping) return;
  stopping = true;
  console.log('');
  console.log('[hermes] stopping container...');
  await run('docker', ['stop', CONTAINER_NAME]);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    cleanup().finally(() => process.exit(0));
  });
}

container.on('error', (error) => {
  fail(`⚠️  启动 docker 失败: ${error.message}`);
});
container.on('exit', (code, signal) => {
  cleanup().finally(() => process.exit(code ?? (signal ? 1 : 0)));
});
