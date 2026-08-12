#!/usr/bin/env bun
// gh CLI wrapper — gh 不走 git credential helper 协议, 自己读 GH_TOKEN env, 所以包一层:
// 现取现用 token 注入 GH_TOKEN 后 exec 真 gh (改名 gh.real)。详见 docs/todo/github.md §三。
import { httpJsonRetry, readToken } from './lib.ts';
import { spawn } from 'node:child_process';

const gateway = process.env['GATEWAY_BASE_URL'];
const containerToken = readToken();
if (!gateway || !containerToken) {
  console.error('lingxi gh wrapper: missing GATEWAY_BASE_URL or LAIFU_USER_TOKEN');
  process.exit(4);
}

const res = (await httpJsonRetry(
  {
    method: 'GET',
    url: `${gateway.replace(/\/+$/, '')}/api/me/oauth/github/token`,
    headers: { Authorization: `Bearer ${containerToken}` },
  },
  1,
).catch((e: Error) => {
  console.error(`lingxi gh wrapper: ${e.message}`);
  console.error('Tip: connect GitHub at the web UI first.');
  process.exit(4);
})) as { token?: string };

if (!res?.token) {
  console.error('lingxi gh wrapper: gateway returned no token; connect GitHub at the web UI first.');
  process.exit(4);
}

const child = spawn('/usr/bin/gh.real', process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, GH_TOKEN: res.token },
});

// 终止信号透传给真 gh, 避免 wrapper 被 kill 后 gh.real 变孤儿进程。
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => child.kill(sig));
}
// spawn 失败 (gh.real 缺失 / 不可执行) 给明确指向, 否则 Bun 抛未捕获异常。
child.on('error', (err) => {
  console.error(`lingxi gh wrapper: cannot exec gh.real: ${err.message}`);
  process.exit(4);
});
// 子进程被信号杀掉时 code=null, 退 1; 正常退出透传其退出码。
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
