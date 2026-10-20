import { MIN_PASSWORD_LENGTH } from './contracts.js';

/** bcrypt 只取前 72 字节, 超出部分被静默忽略 → 直接拒绝, 避免"改了后半截密码仍能登录"。 */
export const MAX_PASSWORD_BYTES = 72;

const encoder = new TextEncoder();

/**
 * 新密码规则(注册 / 修改 / 重置共用, 前端即时校验也用它)。
 * 合法返回 null, 否则返回对应 AuthErrorCode。
 */
export const validateNewPassword = (pw: string): 'password_too_short' | 'password_too_long' | null => {
  if (pw.length < MIN_PASSWORD_LENGTH) return 'password_too_short';
  if (encoder.encode(pw).length > MAX_PASSWORD_BYTES) return 'password_too_long';
  return null;
};
