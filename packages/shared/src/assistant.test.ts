import { describe, it, expect } from 'vitest';
import {
  isValidAssistantName,
  isValidEmailLocalpart,
  MAX_ASSISTANT_NAME_LEN,
  EMAIL_LOCALPART_MIN,
  EMAIL_LOCALPART_MAX,
} from './assistant.js';

describe('isValidAssistantName', () => {
  it('非空 <=24 → true；空/纯空白/超长 → false', () => {
    expect(isValidAssistantName('灵犀')).toBe(true);
    expect(isValidAssistantName('x'.repeat(MAX_ASSISTANT_NAME_LEN))).toBe(true);
    expect(isValidAssistantName('')).toBe(false);
    expect(isValidAssistantName('   ')).toBe(false);
    expect(isValidAssistantName('x'.repeat(MAX_ASSISTANT_NAME_LEN + 1))).toBe(false);
    // @ts-expect-error 故意传错类型
    expect(isValidAssistantName(undefined)).toBe(false);
  });
});

describe('isValidEmailLocalpart', () => {
  it('合法：字母/数字开头结尾，中间含 . _ -', () => {
    expect(isValidEmailLocalpart('aria')).toBe(true);
    expect(isValidEmailLocalpart('lingxi')).toBe(true);
    expect(isValidEmailLocalpart('a.b_c-1')).toBe(true);
    expect(isValidEmailLocalpart('x'.repeat(EMAIL_LOCALPART_MAX))).toBe(true);
    expect(isValidEmailLocalpart('x'.repeat(EMAIL_LOCALPART_MIN))).toBe(true);
  });
  it('非法：太短/太长/非法字符/首尾符号/大写/空', () => {
    expect(isValidEmailLocalpart('ab')).toBe(false);                                // < 3
    expect(isValidEmailLocalpart('x'.repeat(EMAIL_LOCALPART_MAX + 1))).toBe(false); // > 32
    expect(isValidEmailLocalpart('.abc')).toBe(false);                             // 首符号
    expect(isValidEmailLocalpart('abc-')).toBe(false);                             // 尾符号
    expect(isValidEmailLocalpart('a b')).toBe(false);                              // 空格
    expect(isValidEmailLocalpart('张三')).toBe(false);                             // 非 ASCII（不再拼音）
    expect(isValidEmailLocalpart('Aria')).toBe(false);                             // 大写（调用方需先 toLowerCase）
    expect(isValidEmailLocalpart('a@b')).toBe(false);                              // @ 非法
    expect(isValidEmailLocalpart('')).toBe(false);
    // @ts-expect-error 故意传错类型
    expect(isValidEmailLocalpart(undefined)).toBe(false);
  });
});
