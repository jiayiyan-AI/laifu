import { dao } from '../db/index.js';
import { assistantLocalpartBase } from '@lingxi/shared';

/** 旧默认 handle（无名字时兜底，与 NFS 子目录 / shortHash 同源）。 */
export const defaultLocalpart = (userId: string): string =>
  `u-${userId.replace(/-/g, '').slice(0, 8)}`;

/** Postgres 唯一键冲突 (localpart 已被占用)。其它错误(如连接失败)不该被当成"换下一个候选"。 */
const isUniqueViolation = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';

/**
 * 确保该用户有一行 email_addresses，返回其 localpart（幂等）。
 * 规则（方案 A）：local part = 拼音(assistantName) 的 base；同名碰撞按 -2/-3/… 去重，
 * 最终兜底带 userId 短 hash 保证唯一。无名字 / base 为空 → 退回 u-<hash>。
 * localpart 是表主键 + 入站路由键，必须唯一；多 candidate 顺序 insert，撞了试下一个。
 */
export const ensureEmailAddress = async (userId: string, assistantName?: string | null): Promise<string> => {
  const existing = await dao.email.getAddress(userId);
  if (existing) return existing.localpart;            // 幂等：已分配不变

  let name = assistantName ?? null;
  if (name == null) {
    const cm = await dao.containerMapping.getByUserId(userId);
    name = cm?.assistant_name ?? null;
  }

  const base = (name ? assistantLocalpartBase(name) : '') || defaultLocalpart(userId);
  const short = userId.replace(/-/g, '').slice(0, 6);
  const candidates = [base, `${base}-2`, `${base}-3`, `${base}-4`, `${base}-5`, `${base}-${short}`];

  for (const c of candidates) {
    try {
      await dao.email.insertAddress(userId, c, name);   // display_name = 名字（出站 From 友好）
      return c;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;   // 真 DB 错误 → 冒泡，不静默吞
      // localpart 被别的用户占了 → 试下一个 candidate
    }
  }
  // 前面候选都被占用时的终极兜底：带完整 userId hex，按 users 主键保证全局唯一
  const full = `${base}-${userId.replace(/-/g, '')}`;
  await dao.email.insertAddress(userId, full, name);
  return full;
};
