import { describe, it, expect } from 'vitest';
import { IM_PROVIDERS } from '../src/apps/im/providers.js';

describe('IM_PROVIDERS', () => {
  it('id 唯一', () => {
    const ids = IM_PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('每张卡信息位齐全', () => {
    for (const p of IM_PROVIDERS) {
      expect(p.name).toBeTruthy();
      expect(p.brand).toMatch(/^#/);
      expect(p.brandWeak).toBeTruthy();
      expect(p.steps.length).toBe(3);
      expect(p.unboundDesc).toBeTruthy();
      expect(p.icon).toBeTruthy();
    }
  });
  it('微信 available、飞书 available', () => {
    expect(IM_PROVIDERS.find((p) => p.id === 'wechat')?.status).toBe('available');
    expect(IM_PROVIDERS.find((p) => p.id === 'feishu')?.status).toBe('available');
  });
});
