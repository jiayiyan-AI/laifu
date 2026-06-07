import { describe, it, expect } from 'vitest';
import { MANAGEABLE_FEATURES } from '@lingxi/shared';
import { CAPABILITIES } from './capabilities.js';

describe('catalog ↔ MANAGEABLE_FEATURES 不漂移', () => {
  it('所有 removable 能力 id 集合 === MANAGEABLE_FEATURES', () => {
    const removable = CAPABILITIES.filter((c) => c.removable).map((c) => c.id).sort();
    const managed = [...MANAGEABLE_FEATURES].sort();
    expect(removable).toEqual(managed);
  });

  it('进市场的能力都是 removable(基线能力不进市场)', () => {
    for (const c of CAPABILITIES.filter((c) => c.inMarket)) {
      expect(c.removable).toBe(true);
    }
  });

  it('removable 能力必带 enableCopy + disableCopy', () => {
    for (const c of CAPABILITIES.filter((c) => c.removable)) {
      expect(c.enableCopy).toBeTruthy();
      expect(c.disableCopy).toBeTruthy();
    }
  });
});
