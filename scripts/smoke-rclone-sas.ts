/**
 * §九 rclone 冒烟验证 —— 真 Azure 验证 rclone 能否消费我们签的 `sr=d` 目录 SAS。
 *
 * 这是 `verify-cloud-sas.ts` 的姊妹脚本：那个用 SDK 直连验证「前缀隔离」，
 * 这个用**真 rclone 二进制**验证设计文档 §九的三个残余项（源码判定 ✅，服务端语义待冒烟）：
 *   ① HNS 端点语义：rclone 走 blob.core.windows.net（非 dfs）对 sr=d SAS 做 list/read/write 是否被接受
 *   ② scope 隔离：sdd=1 是否真把 SAS 限制在 <user_id>/，越权访问他人前缀应失败
 *   ③ bisync 能否建基线：--resync 在目录 SAS 下是否可用
 *
 * 不依赖 gateway 部署——直接用 gateway 同款 buildDirectoryWriteSas 本地签 SAS，链路等价。
 *
 * 前置：
 *   az login  （账号需 "Storage Blob Data Owner" on 目标 container）
 *   export AZURE_STORAGE_ACCOUNT=<你的 HNS 账户>       # 必须启用 HNS/ADLS Gen2
 *   export AZURE_STORAGE_CONTAINER=laifu-cloud
 *   # rclone：默认用仓库里的 sidecar；也可 export RCLONE_BIN=/path/to/rclone
 *
 * 跑法：
 *   pnpm --filter @lingxi/gateway exec tsx ../../scripts/smoke-rclone-sas.ts
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { buildDirectoryWriteSas } from '../apps/gateway/src/lib/sas-builder.js';
import { UserDelegationKeyCache } from '../apps/gateway/src/lib/user-delegation-key-cache.js';

const account = process.env['AZURE_STORAGE_ACCOUNT'];
const container = process.env['AZURE_STORAGE_CONTAINER'] ?? 'laifu-cloud';
// 脚本位于 <repo>/scripts/，据此定位仓库根，避免依赖运行时 cwd（pnpm --filter 会切到子包目录）。
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// 默认指向仓库里的 mac arm64 sidecar；其它平台或自备 rclone 时 export RCLONE_BIN 覆盖。
const rcloneBin =
  process.env['RCLONE_BIN'] ??
  join(repoRoot, 'apps/desktop/src-tauri/binaries/rclone-aarch64-apple-darwin');
const REMOTE = 'laifu'; // 与 rclone_config.rs REMOTE_NAME 对齐

if (!account) {
  console.error('缺 AZURE_STORAGE_ACCOUNT 环境变量。示例：export AZURE_STORAGE_ACCOUNT=stlingxidev');
  process.exit(1);
}
const endpoint = `https://${account}.blob.core.windows.net`;

const credential = new DefaultAzureCredential();
const serviceClient = new BlobServiceClient(endpoint, credential);
const udkCache = new UserDelegationKeyCache({
  fetcher: async () => {
    const now = new Date(Date.now() - 60_000);
    const expiry = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    return serviceClient.getUserDelegationKey(now, expiry);
  },
  refreshWithinSeconds: 3600,
});

// 造一个 8-4-4-4-12 形式的伪 UUID（sas-builder 要求规范 UUID），后 12 位用时间戳避免重复。
function makeUuid(suffix: string): string {
  const ts = Date.now().toString(16).padStart(12, '0').slice(-12);
  return `aaaaaaaa-bbbb-cccc-dddd-${ts}`.replace('cccc', suffix.padStart(4, '0').slice(0, 4));
}

const USER_A = makeUuid('a000');
const USER_B = makeUuid('b000');

// rclone azureblob 的 sas_url：container 级 URL（rclone 会 strip container 名重建 endpoint，
// sr=d/sdd/sig 保真——见设计文档 §九源码结论）。
function sasUrl(sasToken: string): string {
  return `${endpoint}/${container}?${sasToken}`;
}

function writeConf(path: string, sasToken: string): void {
  writeFileSync(path, `[${REMOTE}]\ntype = azureblob\nsas_url = ${sasUrl(sasToken)}\n`);
}

interface RcResult { code: number; stdout: string; stderr: string; }
function rc(conf: string, args: string[]): RcResult {
  const r = spawnSync(rcloneBin, ['--config', conf, ...args], { encoding: 'utf8' });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function ok(cond: boolean, label: string, detail = ''): void {
  if (cond) {
    console.log(`  \u2705 ${label}`);
  } else {
    console.error(`  \u274c FAIL: ${label}${detail ? '\n     ' + detail : ''}`);
    process.exitCode = 1;
  }
}

function tail(s: string, n = 3): string {
  return s.trim().split('\n').slice(-n).join(' | ');
}

async function main(): Promise<void> {
  console.log(`[smoke] account=${account} container=${container}`);
  console.log(`[smoke] rclone=${rcloneBin}`);
  console.log(`[smoke] USER_A=${USER_A}  USER_B=${USER_B}`);

  const ver = spawnSync(rcloneBin, ['version'], { encoding: 'utf8' });
  if ((ver.status ?? -1) !== 0) {
    console.error(`rclone 不可执行: ${rcloneBin}\n  设 RCLONE_BIN，或跑 bash scripts/fetch-rclone.sh 拉 sidecar`);
    process.exit(1);
  }
  console.log(`[smoke] ${(ver.stdout ?? '').split('\n')[0]}`);

  const udk = await udkCache.get();
  console.log(`[smoke] got UDK, expires: ${udk.signedExpiresOn}`);
  const sasA = buildDirectoryWriteSas({ account: account!, container, userId: USER_A, udk, ttlSeconds: 900 });
  const sasB = buildDirectoryWriteSas({ account: account!, container, userId: USER_B, udk, ttlSeconds: 900 });

  const work = mkdtempSync(join(tmpdir(), 'rclone-smoke-'));
  const confA = join(work, 'a.conf');
  const confB = join(work, 'b.conf');
  writeConf(confA, sasA.sasToken);
  writeConf(confB, sasB.sasToken);

  const remoteA = `${REMOTE}:${container}/${USER_A}`;
  const remoteB = `${REMOTE}:${container}/${USER_B}`;

  const localSrc = join(work, 'src');
  const localDst = join(work, 'dst');
  const bisyncLocal = join(work, 'bisync');
  for (const d of [localSrc, localDst, bisyncLocal]) mkdirSync(d, { recursive: true });
  writeFileSync(join(localSrc, 'hello.txt'), 'hello from rclone smoke');

  // ① HNS 端点语义：上行写 + list
  console.log('\n[\u2460 HNS 端点语义：copy 上行 + lsf]');
  const up = rc(confA, ['copy', localSrc, remoteA, '-v']);
  ok(up.code === 0, 'rclone copy 本地→远端 (上行) 成功', tail(up.stderr));

  const ls = rc(confA, ['lsf', remoteA]);
  ok(ls.code === 0 && ls.stdout.includes('hello.txt'), 'rclone lsf 列到 hello.txt',
    `code=${ls.code} out=${ls.stdout.trim()} err=${ls.stderr.trim().slice(0, 200)}`);

  // 回读（下行）
  console.log('\n[回读：copy 下行]');
  const down = rc(confA, ['copy', remoteA, localDst, '-v']);
  const roundtrip = existsSync(join(localDst, 'hello.txt')) &&
    readFileSync(join(localDst, 'hello.txt'), 'utf8') === 'hello from rclone smoke';
  ok(down.code === 0 && roundtrip, 'rclone copy 远端→本地 (下行) 内容一致', tail(down.stderr));

  // ② scope 隔离：USER_A 的 SAS 越权访问 USER_B 前缀应失败
  console.log('\n[\u2461 scope 隔离：USER_A SAS 访问 USER_B 前缀应被拒]');
  const cross = rc(confA, ['lsf', remoteB]);
  ok(cross.code !== 0, 'USER_A SAS 越权 lsf USER_B/ 被拒 (非 0 退出)',
    `code=${cross.code} err=${cross.stderr.trim().slice(0, 200)}`);
  const crossWrite = rc(confA, ['copy', localSrc, remoteB, '-v']);
  ok(crossWrite.code !== 0, 'USER_A SAS 越权 copy 到 USER_B/ 被拒',
    `code=${crossWrite.code} err=${crossWrite.stderr.trim().slice(0, 200)}`);

  // ③ bisync 建基线 + 增量
  console.log('\n[\u2462 bisync --resync 建基线 + 增量]');
  writeFileSync(join(bisyncLocal, 'local-note.txt'), 'created locally');
  const resync = rc(confA, [
    'bisync', remoteA, bisyncLocal,
    '--resync', '--resilient', '--recover', '--max-lock', '2m',
    '--conflict-resolve', 'newer', '--compare', 'size,modtime', '-v',
  ]);
  ok(resync.code === 0, 'bisync --resync 建基线成功', tail(resync.stderr, 4));

  const bisync2 = rc(confA, [
    'bisync', remoteA, bisyncLocal,
    '--resilient', '--recover', '--max-lock', '2m',
    '--conflict-resolve', 'newer', '--compare', 'size,modtime', '-v',
  ]);
  ok(bisync2.code === 0, 'bisync 增量 (无 --resync) 成功', tail(bisync2.stderr, 4));

  const lsAfter = rc(confA, ['lsf', remoteA]);
  ok(lsAfter.stdout.includes('local-note.txt'), 'bisync 把本地新增文件上行到远端', lsAfter.stdout.trim());

  // 清理（best-effort）
  console.log('\n[cleanup] 删测试前缀 (best-effort)');
  rc(confA, ['delete', remoteA]);
  rc(confB, ['delete', remoteB]);
  rmSync(work, { recursive: true, force: true });

  if (process.exitCode === 1) {
    console.error('\n\u274c 冒烟未全过——见上方 FAIL 项。');
    console.error('   若 \u2460 就失败：rclone 不吃 sr=d SAS，走设计文档 §九「结局 \u26a0\ufe0f/\u274c」分支（新增桌面专用容器 SAS 端点，或退回 Azure SDK 自研内核）。');
    return;
  }
  console.log('\n\u2705 §九 冒烟全过 —— rclone 消费 sr=d 目录 SAS 的三残余项 (HNS 语义 / scope 隔离 / bisync 基线) 服务端确认，主线方案零后端改动成立。');
}

main().catch((err) => {
  console.error('[smoke] fatal:', err);
  process.exit(1);
});
