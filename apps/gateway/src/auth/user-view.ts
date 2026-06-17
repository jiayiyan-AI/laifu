/**
 * user 行 → 对外 AuthMeResponse 的映射。
 * 被 session-routes 与 password-routes 共用,避免两处重复定义。
 */
import type { AuthMeResponse } from '@lingxi/shared';

export interface UserView {
  id: string;
  provider: string;
  external_id: string;
  email: string | null;
  nickname: string | null;
  avatar_url: string | null;
}

export const toMeResponse = (row: UserView): AuthMeResponse => ({
  user_id: row.id,
  provider: row.provider,
  external_id: row.external_id,
  email: row.email,
  nickname: row.nickname,
  avatar_url: row.avatar_url,
});
