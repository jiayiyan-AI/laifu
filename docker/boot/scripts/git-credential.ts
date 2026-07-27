#!/usr/bin/env bun
// git credential helper — git 以 "get" 子命令调它, stdin 喂 protocol/host/path,
// stdout 期望 username/password。store/erase 不处理 (token 由 gateway 管, 容器不缓存)。
//
// 链路: git push --(helper)--> 本脚本 --(HTTP)--> gateway /api/me/oauth/github/token --> plaintext token
// 详见 docs/todo/github.md §三。
import { httpJsonRetry, readToken } from './lib.ts';

if (process.argv[2] !== 'get') process.exit(0); // store / erase 我们不处理

// 吞掉 git 喂进来的 metadata, 我们固定走 github.com (当前 helper 不按仓库区分 token)
await Bun.stdin.text();

const gateway = process.env['GATEWAY_BASE_URL'];
const token = readToken();
if (!gateway || !token) {
  console.error('lingxi-git-credential: missing GATEWAY_BASE_URL or LAIFU_USER_TOKEN');
  process.exit(1);
}

try {
  const res = (await httpJsonRetry(
    {
      method: 'GET',
      url: `${gateway.replace(/\/+$/, '')}/api/me/oauth/github/token`,
      headers: { Authorization: `Bearer ${token}` },
    },
    1, // 网络抖动自动重试一次 (退避 1s)
  )) as { token?: string };
  if (!res?.token) {
    console.error('lingxi-git-credential: no GitHub token; connect GitHub at the web UI first');
    process.exit(1);
  }
  process.stdout.write(`username=x-access-token\npassword=${res.token}\n`);
} catch (err) {
  console.error(`lingxi-git-credential: ${(err as Error).message}`);
  process.exit(1);
}
