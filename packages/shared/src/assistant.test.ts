import { describe, it, expect } from 'vitest';
import { isValidAssistantName, assistantLocalpartBase, MAX_ASSISTANT_NAME_LEN } from './assistant.js';

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

describe('assistantLocalpartBase', () => {
  it('空 → 空串', () => { expect(assistantLocalpartBase('')).toBe(''); expect(assistantLocalpartBase('  ')).toBe(''); });
  it('英文数字直显并小写', () => { expect(assistantLocalpartBase('Aria')).toBe('aria'); });
  it('中文转拼音（无声调、音节相连）', () => {
    expect(assistantLocalpartBase('灵犀')).toBe('lingxi');
    expect(assistantLocalpartBase('张小明')).toBe('zhangxiaoming');
  });
  it('空格 → 连字符', () => {
    expect(assistantLocalpartBase('小助 7')).toBe('xiaozhu-7');
    expect(assistantLocalpartBase('Aria 小助')).toBe('aria-xiaozhu');
  });
  it('全 emoji / 无可用字符 → 空串（兜底由调用方决定）', () => {
    expect(assistantLocalpartBase('🎉🎉')).toBe('');
  });
});
