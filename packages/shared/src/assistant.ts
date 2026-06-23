/** 助理名最大长度（前端 maxLength + 后端兜底共用）。 */
export const MAX_ASSISTANT_NAME_LEN = 24;

/** 名字是否合法：trim 后非空且不超长。前端门控 + 后端兜底共用。 */
export const isValidAssistantName = (name: unknown): name is string => {
  if (typeof name !== 'string') return false;
  const t = name.trim();
  return t.length >= 1 && t.length <= MAX_ASSISTANT_NAME_LEN;
};

/** 邮箱 local part 长度范围（前后端共用）。 */
export const EMAIL_LOCALPART_MIN = 3;
export const EMAIL_LOCALPART_MAX = 32;

/**
 * 用户自填的邮箱前缀（local part）是否合法。前端即时校验 + 后端兜底单一真源。
 * 规则：小写字母/数字开头结尾，中间可含 . _ -；长度 3..32。
 * 调用方负责先 trim + toLowerCase（本函数按字面校验，不替用户改写）。
 */
export const isValidEmailLocalpart = (s: unknown): s is string => {
  if (typeof s !== 'string') return false;
  if (s.length < EMAIL_LOCALPART_MIN || s.length > EMAIL_LOCALPART_MAX) return false;
  return /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(s);
};
