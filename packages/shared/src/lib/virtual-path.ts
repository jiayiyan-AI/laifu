export type ValidationResult = { ok: true } | { ok: false; error: string };

const MAX_SEGMENT_LEN = 200;
const MAX_TOTAL_LEN = 1024;

// 控制字符（U+0000 到 U+001F 和 U+007F）+ 反斜杠
const CONTROL_OR_BACKSLASH = /[\x00-\x1f\x7f\\]/;

/**
 * 校验 agent 提供的虚拟路径是否合法。
 *
 * 规则（与 spec §三 一致）：
 * - 非空，不以 '/' 开头，不以 '/' 结尾
 * - 用 '/' 分段后：每段非空、不为 '.' 或 '..'、长度 ≤ 200
 * - 总长度 ≤ 1024
 * - 不含反斜杠或控制字符（除 '/' 分隔符外）
 *
 * 注意：大小写敏感由调用方负责（Blob 自身大小写敏感）。
 * 不规范化路径（不 collapse `//`、不解析 `.`）—— 任何形态偏差直接拒。
 */
export function validateVirtualPath(path: string): ValidationResult {
  if (path.length === 0) return { ok: false, error: 'path is empty' };
  if (path.length > MAX_TOTAL_LEN) {
    return { ok: false, error: `path total length ${path.length} exceeds max ${MAX_TOTAL_LEN}` };
  }
  if (path.startsWith('/')) return { ok: false, error: 'path is absolute (leading slash)' };
  if (path.endsWith('/')) return { ok: false, error: 'path has trailing slash' };
  if (CONTROL_OR_BACKSLASH.test(path)) {
    return { ok: false, error: 'path contains backslash or control character' };
  }

  const segments = path.split('/');
  for (const seg of segments) {
    if (seg.length === 0) {
      return { ok: false, error: 'path has empty segment (consecutive /)' };
    }
    if (seg === '.' || seg === '..') {
      return { ok: false, error: `path contains parent/current segment "${seg}"` };
    }
    if (seg.length > MAX_SEGMENT_LEN) {
      return { ok: false, error: `segment too long (${seg.length} > ${MAX_SEGMENT_LEN})` };
    }
  }

  return { ok: true };
}
