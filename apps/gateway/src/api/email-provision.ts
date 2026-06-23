import { dao } from '../db/index.js';

/** 默认 handle（用户未自填 localpart 时兜底，与 NFS 子目录 / shortHash 同源）。 */
export const defaultLocalpart = (userId: string): string =>
  `u-${userId.replace(/-/g, '').slice(0, 8)}`;

/** Postgres 唯一键冲突 (localpart 已被占用)。其它错误(如连接失败)不该被当成冲突。 */
// Postgres 唯一键冲突 = SQLSTATE 23505。Drizzle(node-postgres)把驱动错误包成
// DrizzleQueryError,真实 pg code 在 .cause 上,顶层 .code 是 undefined —— 必须两处都看,
// 否则永远判不出冲突(填重复 localpart 会被当普通错误放行)。
const isUniqueViolation = (e: unknown): boolean => {
  if (typeof e !== 'object' || e === null) return false;
  const top = (e as { code?: string }).code;
  const cause = (e as { cause?: { code?: string } }).cause?.code;
  return top === '23505' || cause === '23505';
};

/** 用户自填的 localpart 已被别人占用。purchase 据此回 409 让用户改，不再自动加后缀。 */
export class EmailTakenError extends Error {
  constructor(public readonly localpart: string) {
    super(`email localpart taken: ${localpart}`);
    this.name = 'EmailTakenError';
  }
}

/**
 * 确保该用户有一行 email_addresses，返回其 localpart（幂等）。
 * - 已有地址 → 直接返回（忽略传入 localpart）。
 * - 传入 localpart（用户自填）→ insert；唯一冲突 → 抛 EmailTakenError（不再 -2/-3 自动去重）。
 * - 未传 localpart（留空 / index.ts 回填）→ 用 u-<hash> 默认 insert。
 * display_name 默认取 container_mapping 的 assistant_name（出站 From 友好）。
 * 调用方负责对用户输入先 trim + toLowerCase + isValidEmailLocalpart 校验。
 */
export const claimEmailAddress = async (
  userId: string,
  opts: { localpart?: string | null; displayName?: string | null } = {},
): Promise<string> => {
  const existing = await dao.email.getAddress(userId);
  if (existing) return existing.localpart;            // 幂等：已分配不变

  let displayName = opts.displayName ?? null;
  if (displayName == null) {
    const cm = await dao.containerMapping.getByUserId(userId);
    displayName = cm?.assistant_name ?? null;
  }

  const localpart = (opts.localpart?.trim().toLowerCase() || '') || defaultLocalpart(userId);
  try {
    await dao.email.insertAddress(userId, localpart, displayName);
    return localpart;
  } catch (e) {
    if (isUniqueViolation(e)) throw new EmailTakenError(localpart);
    throw e;   // 真 DB 错误 → 冒泡，不静默吞
  }
};
