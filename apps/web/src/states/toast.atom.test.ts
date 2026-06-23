import { describe, it, expect } from 'vitest';
import { pushToast, dismissToast } from './toast.atom.js';
import type { ToastItem } from './toast.atom.js';

describe('toast reducer', () => {
  it('pushToast 追加一条', () => {
    const next = pushToast([], '微信绑定成功', 'success');
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ msg: '微信绑定成功', kind: 'success' });
    expect(next[0].id).toBeTruthy();
  });
  it('dismissToast 按 id 移除', () => {
    const a: ToastItem = { id: '1', msg: 'a', kind: 'info' };
    const b: ToastItem = { id: '2', msg: 'b', kind: 'info' };
    expect(dismissToast([a, b], '1')).toEqual([b]);
  });
});
