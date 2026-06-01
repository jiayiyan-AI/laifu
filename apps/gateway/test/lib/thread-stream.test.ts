import { describe, it, expect, vi } from 'vitest';
import { ThreadStreamHub } from '../../src/lib/thread-stream.js';

const mockRes = () => ({ write: vi.fn(() => true) } as any);

describe('ThreadStreamHub', () => {
  it('subscribe + emit → write called', () => {
    const hub = new ThreadStreamHub();
    const r = mockRes();
    hub.subscribe('thr_1', r);
    hub.emit('thr_1', 'thread-updated', { thread_id: 'thr_1' });
    expect(r.write).toHaveBeenCalledTimes(1);
    const frame = r.write.mock.calls[0]![0];
    expect(frame).toContain('event: thread-updated');
    expect(frame).toContain('data: {"thread_id":"thr_1"}');
    expect(frame.endsWith('\n\n')).toBe(true);
  });

  it('emit fan-out: 多个订阅都收到', () => {
    const hub = new ThreadStreamHub();
    const r1 = mockRes(), r2 = mockRes(), r3 = mockRes();
    hub.subscribe('thr_1', r1);
    hub.subscribe('thr_1', r2);
    hub.subscribe('thr_2', r3);    // 不同 thread,不该被 'thr_1' 的 emit 触发
    hub.emit('thr_1', 'x', {});
    expect(r1.write).toHaveBeenCalledTimes(1);
    expect(r2.write).toHaveBeenCalledTimes(1);
    expect(r3.write).not.toHaveBeenCalled();
  });

  it('unsubscribe 返回的 fn 把订阅清掉', () => {
    const hub = new ThreadStreamHub();
    const r = mockRes();
    const unsub = hub.subscribe('thr_1', r);
    expect(hub.size('thr_1')).toBe(1);
    unsub();
    expect(hub.size('thr_1')).toBe(0);
    hub.emit('thr_1', 'x', {});
    expect(r.write).not.toHaveBeenCalled();
  });

  it('subscribe 空 thread emit 不抛', () => {
    const hub = new ThreadStreamHub();
    expect(() => hub.emit('thr_empty', 'x', {})).not.toThrow();
  });

  it('write 抛错时 emit 不连锁失败,其它订阅继续收', () => {
    const hub = new ThreadStreamHub();
    const broken = { write: vi.fn(() => { throw new Error('socket closed'); }) } as any;
    const ok = mockRes();
    hub.subscribe('thr_1', broken);
    hub.subscribe('thr_1', ok);
    expect(() => hub.emit('thr_1', 'x', {})).not.toThrow();
    expect(ok.write).toHaveBeenCalledTimes(1);
  });

  it('最后一个订阅 unsub 后,thread 从 map 移除', () => {
    const hub = new ThreadStreamHub();
    const r1 = mockRes(), r2 = mockRes();
    const u1 = hub.subscribe('thr_1', r1);
    const u2 = hub.subscribe('thr_1', r2);
    expect(hub._threadIds()).toContain('thr_1');
    u1();
    expect(hub._threadIds()).toContain('thr_1');
    u2();
    expect(hub._threadIds()).not.toContain('thr_1');
  });
});
