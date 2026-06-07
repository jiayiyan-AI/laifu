import { describe, it, expect } from 'vitest';
import {
  CAPABILITIES, MARKET_CAPABILITIES, getCapability, isEquipped,
} from '../src/lib/capabilities.js';

describe('capabilities catalog', () => {
  it('默认基线 web/file/wechat 不可移除、不进市场', () => {
    for (const id of ['web', 'file', 'wechat']) {
      const c = getCapability(id)!;
      expect(c).toBeTruthy();
      expect(c.removable).toBe(false);
      expect(c.inMarket).toBe(false);
    }
  });

  it('cloud 可移除、进市场、桌面 app=files', () => {
    const c = getCapability('cloud')!;
    expect(c.removable).toBe(true);
    expect(c.inMarket).toBe(true);
    expect(c.desktopApp).toBe('files');
  });

  it('email 可移除、进市场、无桌面 app', () => {
    const c = getCapability('email')!;
    expect(c.removable).toBe(true);
    expect(c.inMarket).toBe(true);
    expect(c.desktopApp).toBeUndefined();
  });

  it('MARKET_CAPABILITIES 只含 inMarket 的能力(本期 = cloud + email)', () => {
    expect(MARKET_CAPABILITIES.map((c) => c.id)).toEqual(['cloud', 'email']);
  });

  it('isEquipped: 默认能力恒真;可装备能力看 observed', () => {
    expect(isEquipped(getCapability('web')!, [])).toBe(true);
    expect(isEquipped(getCapability('cloud')!, [])).toBe(false);
    expect(isEquipped(getCapability('cloud')!, ['cloud'])).toBe(true);
  });

  it('getCapability 未知 id → undefined', () => {
    expect(getCapability('nope')).toBeUndefined();
  });
});
