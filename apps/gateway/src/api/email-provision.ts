import type { EmailDao } from '../db/email-dao.js';

/** 默认 handle: u- + userId 去横线前 8 hex (与 NFS 子目录 / purchase.ts shortHash 同源)。 */
export const defaultLocalpart = (userId: string): string =>
  `u-${userId.replace(/-/g, '').slice(0, 8)}`;

/**
 * 确保该用户有一行 email_addresses, 返回其 localpart (幂等)。
 * - 已有 → 直接返回。
 * - 无 → 插默认 localpart; 若插入冲突(并发或跨用户 8hex 碰撞):
 *     re-query 若已存在(并发别人插好了)→ 返回; 否则用全 hex(=去横线 uuid, 必唯一)重试一次。
 * display_name 本期传 null (发信 From 名回落 config.email.fromDefaultName)。
 */
export const ensureEmailAddress = async (
  dao: Pick<EmailDao, 'getAddress' | 'insertAddress'>,
  userId: string,
): Promise<string> => {
  const existing = await dao.getAddress(userId);
  if (existing) return existing.localpart;

  const short = defaultLocalpart(userId);
  try {
    await dao.insertAddress(userId, short, null);
    return short;
  } catch {
    const again = await dao.getAddress(userId);
    if (again) return again.localpart;            // 并发: 别的请求替本 user 插好了
    const full = `u-${userId.replace(/-/g, '')}`; // 跨用户 8hex 撞 → 全 hex 必唯一
    await dao.insertAddress(userId, full, null);
    return full;
  }
};
