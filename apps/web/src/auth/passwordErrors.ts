import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_BYTES } from '@lingxi/shared';
import { ApiError } from '../lib/api.js';

/** 密码类错误码 → 中文。未知错误透出真实信息。 */
export const passwordErrorMessage = (e: unknown, fallback: string): string => {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'password_too_short': return `密码至少 ${MIN_PASSWORD_LENGTH} 位`;
      case 'password_too_long': return `密码过长（最多 ${MAX_PASSWORD_BYTES} 字节，约 ${MAX_PASSWORD_BYTES / 3} 个汉字）`;
      case 'wrong_password': return '当前密码不正确';
      case 'not_password_account': return '该账号通过第三方登录，没有密码';
      case 'invalid_or_expired_token': return '链接无效或已过期';
      case 'rate_limited': return '尝试过于频繁，请稍后再试';
      default: return `${fallback}：${e.message}`;
    }
  }
  return fallback;
};

/** 前端即时校验: 返回错误文案或 null。 */
export const newPasswordProblem = (pw: string, confirm: string, validate: (p: string) => string | null): string | null => {
  const code = validate(pw);
  if (code === 'password_too_short') return `密码至少 ${MIN_PASSWORD_LENGTH} 位`;
  if (code === 'password_too_long') return `密码过长（最多 ${MAX_PASSWORD_BYTES} 字节）`;
  if (pw !== confirm) return '两次输入的新密码不一致';
  return null;
};
