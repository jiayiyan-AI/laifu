import { dao } from '../db/index.js';

/** 默认 handle: u- + userId 去横线前 8 hex (与 NFS 子目录 / purchase.ts shortHash 同源)。 */
export const defaultLocalpart = (userId: string): string =>
  `u-${userId.replace(/-/g, '').slice(0, 8)}`;

/**
 * 确保该用户有一行 email_addresses, 返回其 localpart (幂等)。
 */
export const ensureEmailAddress = async (userId: string): Promise<string> => {
  const existing = await dao.email.getAddress(userId);
  if (existing) return existing.localpart;

  const short = defaultLocalpart(userId);
  try {
    await dao.email.insertAddress(userId, short, null);
    return short;
  } catch {
    const again = await dao.email.getAddress(userId);
    if (again) return again.localpart;
    const full = `u-${userId.replace(/-/g, '')}`;
    await dao.email.insertAddress(userId, full, null);
    return full;
  }
};
