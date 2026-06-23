import { pinyin } from 'pinyin-pro';

/** 助理名最大长度（前端 maxLength + 后端兜底共用）。 */
export const MAX_ASSISTANT_NAME_LEN = 24;

/** 名字是否合法：trim 后非空且不超长。前端门控 + 后端兜底共用。 */
export const isValidAssistantName = (name: unknown): name is string => {
  if (typeof name !== 'string') return false;
  const t = name.trim();
  return t.length >= 1 && t.length <= MAX_ASSISTANT_NAME_LEN;
};

/**
 * 名字 → 邮箱 local part 的 base（不含碰撞后缀，前后端单一真源）。
 * - 按空白切段，段间连字符；
 * - 段内：中文→拼音(无声调、相连)，ASCII 取 [a-z0-9] 小写，其余丢弃；
 * - 空输入 / 全被丢弃 → ''（兜底策略由调用方定）。
 */
export const assistantLocalpartBase = (name: string): string => {
  const trimmed = name.trim();
  if (!trimmed) return '';
  const segments = trimmed.split(/\s+/).map((seg) => {
    const py = pinyin(seg, { toneType: 'none', type: 'array' }).join('');
    return py.toLowerCase().replace(/[^a-z0-9]/g, '');
  }).filter(Boolean);
  return segments.join('-');
};
