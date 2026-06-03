import { describe, it, expect } from 'vitest';
import { buildContentDisposition } from '../../src/lib/content-disposition.js';

describe('buildContentDisposition', () => {
  describe('disposition type', () => {
    it('uses attachment when type=attachment', () => {
      expect(buildContentDisposition('attachment', 'a.pdf')).toMatch(/^attachment;/);
    });

    it('uses inline when type=inline', () => {
      expect(buildContentDisposition('inline', 'a.pdf')).toMatch(/^inline;/);
    });
  });

  describe('ASCII filename', () => {
    it('uses plain quoted form for simple ASCII names', () => {
      const r = buildContentDisposition('attachment', 'report.pdf');
      expect(r).toBe('attachment; filename="report.pdf"');
    });

    it('keeps simple ASCII names with dots/dashes/underscores', () => {
      const r = buildContentDisposition('attachment', 'q2-sales_2026.pdf');
      expect(r).toBe('attachment; filename="q2-sales_2026.pdf"');
    });
  });

  describe('non-ASCII filename (Chinese, emoji)', () => {
    it('encodes Chinese with filename*=UTF-8 RFC 5987', () => {
      const r = buildContentDisposition('attachment', '销售报告.pdf');
      expect(r).toMatch(/filename\*=UTF-8''/);
      expect(r).toContain('%E9%94%80%E5%94%AE%E6%8A%A5%E5%91%8A.pdf');
    });

    it('includes ASCII fallback alongside the encoded form', () => {
      const r = buildContentDisposition('attachment', '销售报告.pdf');
      expect(r).toMatch(/filename="[^"]*\.pdf"/);
      expect(r).toMatch(/filename\*=UTF-8''/);
    });

    it('encodes emoji', () => {
      const r = buildContentDisposition('attachment', '🎉party.png');
      expect(r).toMatch(/filename\*=UTF-8''/);
      expect(r).toContain('%F0%9F%8E%89');
    });
  });

  describe('special characters', () => {
    it('encodes spaces (which are not allowed in unquoted token form)', () => {
      const r = buildContentDisposition('attachment', 'my report.pdf');
      expect(r).toMatch(/filename="my report\.pdf"|filename\*=UTF-8''my%20report\.pdf/);
    });

    it('encodes quotes and backslashes safely', () => {
      const r = buildContentDisposition('attachment', 'a"b\\c.txt');
      expect(r).toMatch(/filename\*=UTF-8''/);
    });
  });

  describe('edge cases', () => {
    it('handles empty filename by using a generic name', () => {
      const r = buildContentDisposition('attachment', '');
      expect(r).toMatch(/filename="(file|download)"/i);
    });
  });
});
