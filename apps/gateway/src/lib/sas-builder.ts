import { createHmac } from 'node:crypto';
import {
  BlobSASPermissions,
  SASProtocol,
  generateBlobSASQueryParameters,
  type UserDelegationKey,
} from '@azure/storage-blob';

export interface DirectoryWriteSasInput {
  account: string;       // storage account name, e.g. "laifudev"
  container: string;     // "laifu-cloud"
  userId: string;        // UUID, 作为一级目录
  udk: UserDelegationKey;
  ttlSeconds: number;    // SAS TTL, 推荐 900 (15min)
}

export interface DirectoryWriteSasOutput {
  sasToken: string;            // query string, 不含前导 '?'
  expiresAt: Date;
  prefix: string;              // "<userId>/"
}

const SAS_VERSION = '2020-02-10'; // 最早支持 sdd 的 service version
// directory SAS 当前签的是 `<container>/<userId>` 单层目录，深度恒为 1。
const SIGNED_DIRECTORY_DEPTH = 1;
// directory write SAS 固定权限集合，按 Azure SAS 规范字典序 racwdxltmeop 排列后即 "racwl"。
const PERMISSIONS = 'racwl';

/**
 * 将任意 Date / ISO 字符串规范成 `YYYY-MM-DDTHH:mm:ssZ`（秒级，UTC）。
 * Azure SAS 签名要求时间字段不带毫秒，否则签名串与服务端重算的不一致。
 */
function toIso8601Seconds(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * 构造 canonicalized resource：`/blob/<account>/<container>/<dirPath>`。
 * 注意：dirPath（含 userId）**不带**尾随 `/`，否则服务端 string-to-sign 不匹配。
 */
function canonicalizedResource(account: string, container: string, dirPath: string): string {
  const trimmed = dirPath.replace(/\/+$/, '');
  return `/blob/${account}/${container}/${trimmed}`;
}

/**
 * HMAC-SHA256(base64-decoded UDK value, stringToSign) → base64。
 */
function sign(stringToSign: string, udkValueBase64: string): string {
  const key = Buffer.from(udkValueBase64, 'base64');
  return createHmac('sha256', key).update(stringToSign, 'utf8').digest('base64');
}

/**
 * 签发一个 directory-scoped User Delegation SAS，授权 racwl 限定到
 * `<container>/<userId>/` 子树。
 *
 * 客户端拼 URL 时形如：
 *   `${blob_endpoint}/${container}/${userId}/<virtual_path>?${sasToken}`
 *
 * directory SAS 要求 storage account 启用 Hierarchical Namespace
 * （ADLS Gen2）。非 HNS 账号上 Azure 会拒绝 `sr=d` 请求 —
 * 测试 + 验收脚本会发现这种偏差。
 *
 * 为什么手写签名而不用 SDK：`@azure/storage-blob@12.31.0` 的
 * `generateBlobSASQueryParameters` 不支持 `sr=d`：所有代码路径产生的
 * `sr ∈ {c, b, bs, bv}`，且 `signedDirectoryDepth (sdd)` 永远不会写进
 * string-to-sign。SDK 内部 `BlobSASSignatureValues.js` 的 v2020-02-10 UDK
 * 槽位顺序我们沿用 —— 只是把 `signedResource` 换成 `"d"`，并按 spec 在
 * canonicalizedResource 之后嵌入 `sdd=1` 的内容。
 *
 * 字符串构造、签名、URL 编码全在这里完成，**绝对不要**对返回的
 * `sasToken` 再做 `URLSearchParams` 之类的二次组装，那会让签名失效。
 *
 * **Trust boundary**: `userId` MUST be resolved from a verified JWT/session by
 * the caller; never from request body, path, or query — those are
 * attacker-controlled. The function validates UUID shape as defense-in-depth
 * but the security boundary is upstream.
 */
export function buildDirectoryWriteSas(input: DirectoryWriteSasInput): DirectoryWriteSasOutput {
  // Trust boundary: caller (gateway HTTP routes) MUST resolve userId from a
  // verified JWT/session, never from request body/path. We still validate here
  // as defense-in-depth — a malformed userId could otherwise corrupt the
  // canonicalizedResource and silently shift the SAS scope.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.userId)) {
    throw new Error('sas-builder: invalid userId — must be canonical UUID');
  }
  if (!/^[a-z0-9]{3,24}$/.test(input.account)) {
    throw new Error('sas-builder: invalid account — must match Azure storage naming rules (3-24 lowercase alphanumeric)');
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(input.container)) {
    throw new Error('sas-builder: invalid container — must match Azure container naming rules');
  }

  const now = Date.now();
  const startsOn = new Date(now - 60 * 1000);        // 留 1 分钟时钟漂移
  const expiresOn = new Date(now + input.ttlSeconds * 1000);

  const signedStart = toIso8601Seconds(startsOn);
  const signedExpiry = toIso8601Seconds(expiresOn);
  const signedKeyStart = toIso8601Seconds(input.udk.signedStartsOn);
  const signedKeyExpiry = toIso8601Seconds(input.udk.signedExpiresOn);

  const resourcePath = `${input.userId}`; // 单层目录；不带尾随 `/`
  const canonicalResource = canonicalizedResource(input.account, input.container, resourcePath);

  // String-to-sign for v2020-02-10 User Delegation SAS, signedResource="d".
  // Spec ref: https://learn.microsoft.com/en-us/rest/api/storageservices/create-user-delegation-sas
  // SDK ref: node_modules/@azure/storage-blob/.../BlobSASSignatureValues.js lines ~400-432 (non-directory variant)
  // 23 fields joined by '\n' → exactly 22 '\n' chars, no trailing newline.
  const stringToSign = [
    PERMISSIONS,                  //  1. signedPermissions   "racwl"
    signedStart,                  //  2. signedStart
    signedExpiry,                 //  3. signedExpiry
    canonicalResource,            //  4. canonicalizedResource
    input.udk.signedObjectId,     //  5. signedKeyObjectId
    input.udk.signedTenantId,     //  6. signedKeyTenantId
    signedKeyStart,               //  7. signedKeyStart
    signedKeyExpiry,              //  8. signedKeyExpiry
    input.udk.signedService,      //  9. signedKeyService
    input.udk.signedVersion,      // 10. signedKeyVersion
    '',                           // 11. signedAuthorizedUserObjectId (preauthorizedAgentObjectId)
    '',                           // 12. signedUnauthorizedUserObjectId (agentObjectId)
    '',                           // 13. signedCorrelationId
    '',                           // 14. signedIP
    'https',                      // 15. signedProtocol
    SAS_VERSION,                  // 16. signedVersion
    'd',                          // 17. signedResource
    '',                           // 18. signedTimestamp (snapshot/version — n/a for dir)
    '',                           // 19. rscc (cacheControl)
    '',                           // 20. rscd (contentDisposition)
    '',                           // 21. rsce (contentEncoding)
    '',                           // 22. rscl (contentLanguage)
    '',                           // 23. rsct (contentType)
  ].join('\n');

  const signature = sign(stringToSign, input.udk.value);

  // 按 spec 拼 query string。每个 value 都 encodeURIComponent，特别是 sig：
  // base64 字符串可能含 '+' '/' '='，必须 URL 编码，否则服务端 decode 后与本地不一致。
  const pairs: Array<[string, string]> = [
    ['sv', SAS_VERSION],
    ['sr', 'd'],
    ['sdd', String(SIGNED_DIRECTORY_DEPTH)],
    ['st', signedStart],
    ['se', signedExpiry],
    ['sp', PERMISSIONS],
    ['spr', 'https'],
    ['skoid', input.udk.signedObjectId],
    ['sktid', input.udk.signedTenantId],
    ['skt', signedKeyStart],
    ['ske', signedKeyExpiry],
    ['sks', input.udk.signedService],
    ['skv', input.udk.signedVersion],
    ['sig', signature],
  ];

  const sasToken = pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

  return {
    sasToken,
    expiresAt: expiresOn,
    prefix: `${input.userId}/`,
  };
}

// === Read SAS (sr=b, blob-scoped) — uses Azure SDK directly, no hand-signing needed ===

export interface ReadBlobSasInput {
  account: string;
  container: string;
  blobName: string;             // full blob name (including <user_id>/<virtual_path>)
  udk: UserDelegationKey;
  ttlSeconds: number;
  contentDisposition?: string;  // optional: SAS rscd parameter (e.g. 'attachment; filename*=UTF-8''...')
}

export interface ReadBlobSasOutput {
  sasToken: string;
  expiresAt: Date;
}

/**
 * Build a blob-scoped read SAS using the Azure SDK. Unlike buildDirectoryWriteSas
 * (which hand-signs because SDK doesn't support sr=d), the read case uses sr=b
 * which is natively supported. The SDK handles the canonicalized resource + sig.
 */
export function buildReadBlobSas(input: ReadBlobSasInput): ReadBlobSasOutput {
  const startsOn = new Date(Date.now() - 60 * 1000);
  const expiresOn = new Date(Date.now() + input.ttlSeconds * 1000);

  const permissions = BlobSASPermissions.from({ read: true });

  // The SDK's internal truncatedISO8061Date helper calls .toISOString(), so it requires
  // signedStartsOn / signedExpiresOn to be Date objects. The Azure service returns Dates,
  // but the generated model type declares them as string — normalise to Date at runtime.
  const toDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));
  const normalizedUdk: UserDelegationKey = {
    ...input.udk,
    signedStartsOn: toDate(input.udk.signedStartsOn),
    signedExpiresOn: toDate(input.udk.signedExpiresOn),
  };

  const sasQueryParams = generateBlobSASQueryParameters(
    {
      containerName: input.container,
      blobName: input.blobName,
      permissions,
      protocol: SASProtocol.Https,
      startsOn,
      expiresOn,
      version: '2020-02-10',
      contentDisposition: input.contentDisposition,
    },
    normalizedUdk,
    input.account,
  );

  return {
    sasToken: sasQueryParams.toString(),
    expiresAt: expiresOn,
  };
}

// === Write SAS (sr=b, blob-scoped) — 给 CF Worker 直传单个附件 blob 用 ===

export interface WriteBlobSasInput {
  account: string;
  container: string;
  blobName: string;   // email-attachments 容器内相对路径,如 "01JABC-quote.pdf"
  udk: UserDelegationKey;
  ttlSeconds: number; // 推荐 300 (5min)
}

export interface WriteBlobSasOutput {
  sasToken: string;
  expiresAt: Date;
}

/**
 * blob-scoped 写 SAS(create + write),最小授权:仅该 blob、仅写、短 TTL。
 * 与 buildReadBlobSas 同构,用 SDK(sr=b 原生支持)。
 */
export function buildWriteBlobSas(input: WriteBlobSasInput): WriteBlobSasOutput {
  const startsOn = new Date(Date.now() - 60 * 1000);
  const expiresOn = new Date(Date.now() + input.ttlSeconds * 1000);
  const permissions = BlobSASPermissions.from({ create: true, write: true });

  const toDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));
  const normalizedUdk: UserDelegationKey = {
    ...input.udk,
    signedStartsOn: toDate(input.udk.signedStartsOn),
    signedExpiresOn: toDate(input.udk.signedExpiresOn),
  };

  const sasQueryParams = generateBlobSASQueryParameters(
    {
      containerName: input.container,
      blobName: input.blobName,
      permissions,
      protocol: SASProtocol.Https,
      startsOn,
      expiresOn,
      version: '2020-02-10',
    },
    normalizedUdk,
    input.account,
  );

  return { sasToken: sasQueryParams.toString(), expiresAt: expiresOn };
}
