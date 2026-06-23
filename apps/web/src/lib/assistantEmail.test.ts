import { describe, it, expect } from 'vitest';
import { assistantEmailPreview } from './assistantEmail.js';

const D = 'mail.laifu.uncagedai.org';

describe('assistantEmailPreview', () => {
  it('空名 → —@域名 占位', () => {
    expect(assistantEmailPreview('', D)).toBe(`—@${D}`);
    expect(assistantEmailPreview('   ', D)).toBe(`—@${D}`);
  });
  it('正常 → base@域名', () => {
    expect(assistantEmailPreview('灵犀', D)).toBe(`lingxi@${D}`);
    expect(assistantEmailPreview('Aria', D)).toBe(`aria@${D}`);
  });
  it('全 emoji → assistant 兜底', () => {
    expect(assistantEmailPreview('🎉', D)).toBe(`assistant@${D}`);
  });
});
