import { describe, it, expect } from 'vitest';
import { isPreviewable, sourceBadge } from '../src/apps/files/utils.js';

describe('isPreviewable', () => {
  it('true for pdf by content-type', () => {
    expect(isPreviewable({ content_type: 'application/pdf', virtual_path: 'a.pdf' })).toBe(true);
  });
  it('true for image by content-type', () => {
    expect(isPreviewable({ content_type: 'image/png', virtual_path: 'a.png' })).toBe(true);
  });
  it('true for pdf by extension when content-type null', () => {
    expect(isPreviewable({ content_type: null, virtual_path: 'a.pdf' })).toBe(true);
  });
  it('false for csv', () => {
    expect(isPreviewable({ content_type: 'text/csv', virtual_path: 'a.csv' })).toBe(false);
  });
  it('false for csv when content-type null (extension path)', () => {
    expect(isPreviewable({ content_type: null, virtual_path: 'a.csv' })).toBe(false);
  });
});

describe('sourceBadge', () => {
  it('returns a marker for web source', () => {
    expect(sourceBadge('web')).toBe('↥');
  });
  it('returns empty for agent source', () => {
    expect(sourceBadge('agent')).toBe('');
  });
});
