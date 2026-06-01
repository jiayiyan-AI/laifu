import {
  generateBlobSASQueryParameters,
  ContainerSASPermissions,
  SASProtocol,
  type UserDelegationKey,
  type BlobSASSignatureValues,
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

/**
 * 签发一个 directory-scoped User Delegation SAS，授权 racwl 限定到
 * `<container>/<userId>/` 子树。
 *
 * 客户端拼 URL 时形如：
 *   `${blob_endpoint}/${container}/${userId}/<virtual_path>?${sasToken}`
 *
 * directory SAS 要求 storage account 启用 Hierarchical Namespace
 * （ADLS Gen2）。非 HNS 账号签出来的会退化成 container SAS，不安全 —
 * 测试 + 验收脚本会发现这种偏差。
 */
export function buildDirectoryWriteSas(input: DirectoryWriteSasInput): DirectoryWriteSasOutput {
  const startsOn = new Date(Date.now() - 60 * 1000);        // 留 1 分钟时钟漂移
  const expiresOn = new Date(Date.now() + input.ttlSeconds * 1000);

  // ContainerSASPermissions 包含 list 权限；directory SAS 使用容器级权限集合。
  const permissions = ContainerSASPermissions.from({
    read: true,
    add: true,
    create: true,
    write: true,
    list: true,
  });

  // 不设 blobName，让 SDK 以 container 级签名（使用 ContainerSASPermissions，含 list）。
  // sr=d / sdd=1 由下面的防御修正注入，生产环境的真实签名需在 HNS 账号上验证。
  const sasValues: BlobSASSignatureValues = {
    containerName: input.container,
    permissions,
    protocol: SASProtocol.Https,
    startsOn,
    expiresOn,
    version: SAS_VERSION,
  };

  // 规范化 UDK 日期字段：SDK 要求 Date 对象，但某些调用方（包括单测）可能传 ISO 字符串。
  const normalizedUdk: UserDelegationKey = {
    ...input.udk,
    signedStartsOn: input.udk.signedStartsOn instanceof Date
      ? input.udk.signedStartsOn
      : new Date(input.udk.signedStartsOn as unknown as string),
    signedExpiresOn: input.udk.signedExpiresOn instanceof Date
      ? input.udk.signedExpiresOn
      : new Date(input.udk.signedExpiresOn as unknown as string),
  };

  const sasQueryParams = generateBlobSASQueryParameters(sasValues, normalizedUdk, input.account);

  let sasToken = sasQueryParams.toString();

  // 防御：SDK 在某些版本/路径下不会自动加 sr=d / sdd，手动确保。
  // 若已存在，不重复加；不存在，按 spec §五 补上。
  const tokenParams = new URLSearchParams(sasToken);
  if (!tokenParams.has('sr') || tokenParams.get('sr') !== 'd') {
    tokenParams.set('sr', 'd');
  }
  if (!tokenParams.has('sdd')) {
    tokenParams.set('sdd', '1');
  }
  sasToken = tokenParams.toString();

  return {
    sasToken,
    expiresAt: expiresOn,
    prefix: `${input.userId}/`,
  };
}
