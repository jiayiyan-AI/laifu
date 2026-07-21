import { describe, it, expect } from 'vitest';
import { buildInboxPrompt, formatSize } from '../../src/lib/inbox-image-prompt.js';

describe('buildInboxPrompt', () => {
  it('returns text unchanged when no attachments and no errors', () => {
    expect(buildInboxPrompt('hello', [], [])).toBe('hello');
  });

  it('lists attachment paths and includes the original text', () => {
    const out = buildInboxPrompt('描述这张图', [
      { kind: 'image', cache_path: '/c/img_x.jpg', content_type: 'image/jpeg', size: 1_258_291 },
    ], []);
    expect(out).toContain('收到 1 张图片');
    expect(out).toContain('/c/img_x.jpg (image/jpeg, 1.2 MB)');
    expect(out).toContain('描述这张图');
  });

  it('keeps prompt without user text when text is empty', () => {
    const out = buildInboxPrompt('', [
      { kind: 'image', cache_path: '/c/img_x.jpg', content_type: 'image/jpeg', size: 240 * 1024 },
    ], []);
    expect(out).toContain('收到 1 张图片');
    expect(out).toContain('240 KB');
  });

  it('appends a failure notice when fetchErrors present', () => {
    const out = buildInboxPrompt('hi', [], ['boom']);
    expect(out).toContain('⚠️ 1 个附件下载失败');
    expect(out).toContain('hi');
  });
});

describe('formatSize', () => {
  it('formats MB / KB / B', () => {
    expect(formatSize(1_258_291)).toBe('1.2 MB');
    expect(formatSize(240 * 1024)).toBe('240 KB');
    expect(formatSize(512)).toBe('512 B');
  });
});
