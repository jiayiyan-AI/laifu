import { describe, it, expect } from 'vitest';
import { validateVirtualPath } from '../src/lib/virtual-path.js';

describe('validateVirtualPath', () => {
  describe('合法路径', () => {
    it('单层文件名', () => {
      expect(validateVirtualPath('report.pdf')).toEqual({ ok: true });
    });

    it('多层嵌套', () => {
      expect(validateVirtualPath('reports/2026-06/sales.pdf')).toEqual({ ok: true });
    });

    it('UTF-8 中文文件名', () => {
      expect(validateVirtualPath('reports/销售/季度报告.pdf')).toEqual({ ok: true });
    });

    it('数字 + 短划线 + 下划线 + 点', () => {
      expect(validateVirtualPath('logs/2026-06-01_run.log.gz')).toEqual({ ok: true });
    });

    it('单段恰好 200 字符（边界）', () => {
      const seg = 'a'.repeat(200);
      expect(validateVirtualPath(seg)).toEqual({ ok: true });
    });

    it('总长恰好 1024 字符（边界）', () => {
      // 200*5 + 5 separators + 19 = 1000 + 5 + 19 = 1024
      const path1024 = 'a'.repeat(200) + '/' + 'a'.repeat(200) + '/' + 'a'.repeat(200) + '/' + 'a'.repeat(200) + '/' + 'a'.repeat(200) + '/' + 'a'.repeat(19);
      expect(path1024.length).toBe(1024);
      expect(validateVirtualPath(path1024)).toEqual({ ok: true });
    });
  });

  describe('非法路径', () => {
    it('空字符串', () => {
      const r = validateVirtualPath('');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/empty/i);
    });

    it('绝对路径（以 / 开头）', () => {
      const r = validateVirtualPath('/reports/x.pdf');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/absolute|leading slash/i);
    });

    it('包含 .. 段', () => {
      const r = validateVirtualPath('reports/../etc/passwd');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/\.\.|parent/i);
    });

    it('单独 .. 段', () => {
      const r = validateVirtualPath('..');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/parent|current/i);
    });

    it('. 段（当前目录指代）也禁', () => {
      const r = validateVirtualPath('./report.pdf');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/parent|current/i);
    });

    it('空段（连续 //）', () => {
      const r = validateVirtualPath('reports//x.pdf');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/empty segment/i);
    });

    it('末尾 /', () => {
      const r = validateVirtualPath('reports/');
      expect(r.ok).toBe(false);
    });

    it('反斜杠', () => {
      const r = validateVirtualPath('reports\\x.pdf');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/backslash|invalid char/i);
    });

    it('NUL 字符', () => {
      const r = validateVirtualPath('reports/x\x00.pdf');
      expect(r.ok).toBe(false);
    });

    it('其他控制字符（换行）', () => {
      const r = validateVirtualPath('reports/x\n.pdf');
      expect(r.ok).toBe(false);
    });

    it('单段超长（>200）', () => {
      const longSeg = 'a'.repeat(201);
      const r = validateVirtualPath(`reports/${longSeg}.pdf`);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/segment.*long|too long/i);
    });

    it('总长超长（>1024）', () => {
      const seg = 'a'.repeat(200);
      const path = Array(6).fill(seg).join('/'); // 6 * 200 + 5 separators = 1205
      const r = validateVirtualPath(path);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/total length|too long/i);
    });
  });
});
