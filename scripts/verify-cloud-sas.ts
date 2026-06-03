/**
 * P0 验收脚本 —— 真 Azure 验证 directory SAS 限定到 prefix 是否生效。
 *
 * 流程：
 *   1. 用 DefaultAzureCredential 连 Azure（要求 az login 完成 + 当前账号有
 *      "Storage Blob Data Owner" 角色 in laifu-cloud container）
 *   2. 拿 User Delegation Key (7d)
 *   3. 用 sas-builder 给一个 fake user_id = "user-a" 签 SAS
 *   4. PUT 文件到 user-a/test.txt → 应 201
 *   5. PUT 文件到 user-b/test.txt → 应 403 (跨前缀)
 *   6. 再签一个 user-b 的 SAS
 *   7. 用 user-b 的 SAS PUT 到 user-a/test.txt → 应 403
 *
 * 跑法:
 *   az login
 *   export AZURE_STORAGE_ACCOUNT=stlingxidev
 *   export AZURE_STORAGE_CONTAINER=laifu-cloud
 *   pnpm --filter @lingxi/gateway exec tsx ../../scripts/verify-cloud-sas.ts
 */

import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { buildDirectoryWriteSas } from '../apps/gateway/src/lib/sas-builder.js';
import { UserDelegationKeyCache } from '../apps/gateway/src/lib/user-delegation-key-cache.js';

const account = process.env['AZURE_STORAGE_ACCOUNT'];
const container = process.env['AZURE_STORAGE_CONTAINER'] ?? 'laifu-cloud';
if (!account) {
  console.error('Missing AZURE_STORAGE_ACCOUNT env. See infra/azure/cloud-storage.md.');
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

// 注意：sas-builder 现在校验 userId 必须是规范 UUID 格式（lowercase hex with dashes）。
// 不能再用 'user-a-' + Date.now()。改用 deterministic 但 collision-safe 的 UUID-shaped 字符串。
function makeUuid(suffix: string): string {
  // 拼一个 8-4-4-4-12 形式的伪 UUID，前 28 char 固定，后 4 char 用时间戳避免重复
  const ts = Date.now().toString(16).padStart(12, '0').slice(-12);
  return `aaaaaaaa-bbbb-cccc-dddd-${ts}`.replace('cccc', suffix.padStart(4, '0').slice(0, 4));
}

const USER_A = makeUuid('a000');
const USER_B = makeUuid('b000');

async function tryPut(sasUrl: string, body: string): Promise<{ ok: boolean; status: number; }> {
  const resp = await fetch(sasUrl, {
    method: 'PUT',
    headers: {
      'x-ms-blob-type': 'BlockBlob',
      'Content-Length': String(Buffer.byteLength(body)),
    },
    body,
  });
  return { ok: resp.ok, status: resp.status };
}

async function main(): Promise<void> {
  console.log(`[verify] storage account: ${account}`);
  console.log(`[verify] container:       ${container}`);
  console.log(`[verify] USER_A:          ${USER_A}`);
  console.log(`[verify] USER_B:          ${USER_B}`);

  const udk = await udkCache.get();
  console.log(`[verify] got UDK, expires: ${udk.signedExpiresOn}`);

  // === user-A SAS ===
  const sasA = buildDirectoryWriteSas({
    account: account!,
    container,
    userId: USER_A,
    udk,
    ttlSeconds: 900,
  });
  console.log(`[verify] SAS for ${USER_A}: ${sasA.sasToken.slice(0, 80)}...`);

  // === Case 1: PUT 到自己 prefix → 应 201 ===
  const urlA_own = `${endpoint}/${container}/${USER_A}/hello.txt?${sasA.sasToken}`;
  const r1 = await tryPut(urlA_own, 'hello from user A');
  console.log(`[case 1] PUT ${USER_A}/hello.txt -> ${r1.status} (expected 201)`);
  if (r1.status !== 201) {
    console.error('  ❌ FAIL: 同前缀 PUT 应 201');
    process.exit(2);
  }

  // === Case 2: 用 user-A 的 SAS PUT 到 user-B → 应 403 ===
  const urlA_cross = `${endpoint}/${container}/${USER_B}/x.txt?${sasA.sasToken}`;
  const r2 = await tryPut(urlA_cross, 'malicious cross-write');
  console.log(`[case 2] PUT ${USER_B}/x.txt with USER_A SAS -> ${r2.status} (expected 403)`);
  if (r2.status !== 403) {
    console.error('  ❌ FAIL: 跨前缀 PUT 必须 403');
    console.error('  原因可能: SAS 实际是 container-scope (sr=c), 不是 directory-scope。');
    console.error('  检查: storage account 是否启用 HNS / SDK 版本是否支持 directory SAS。');
    process.exit(3);
  }

  // === Case 3: user-B 的 SAS 拿来跨前缀也要 403 ===
  const sasB = buildDirectoryWriteSas({
    account: account!,
    container,
    userId: USER_B,
    udk,
    ttlSeconds: 900,
  });
  const urlB_cross = `${endpoint}/${container}/${USER_A}/y.txt?${sasB.sasToken}`;
  const r3 = await tryPut(urlB_cross, 'B trying to write to A');
  console.log(`[case 3] PUT ${USER_A}/y.txt with USER_B SAS -> ${r3.status} (expected 403)`);
  if (r3.status !== 403) {
    console.error('  ❌ FAIL: 反向跨前缀 PUT 必须 403');
    process.exit(4);
  }

  console.log('\n✅ P0 acceptance PASS — directory SAS 限定 prefix 真生效');
}

main().catch((err) => {
  console.error('[verify] fatal:', err);
  process.exit(1);
});
