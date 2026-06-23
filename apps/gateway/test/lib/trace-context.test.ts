import { describe, it, expect, vi } from 'vitest';
import {
  runWithTrace,
  getTraceId,
  currentTrace,
  setTraceFields,
} from '../../src/lib/trace-context.js';
import { log } from '../../src/lib/logger.js';

const captureLog = (fn: () => void): string[] => {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((l: unknown) => {
    lines.push(String(l));
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines;
};

describe('trace-context', () => {
  it('getTraceId 在上下文内取到, 上下文外为 undefined', () => {
    expect(getTraceId()).toBeUndefined();
    runWithTrace({ trace_id: 'tr_x' }, () => {
      expect(getTraceId()).toBe('tr_x');
    });
    expect(getTraceId()).toBeUndefined();
  });

  it('setTraceFields 原地补字段, 同上下文后续可见', () => {
    runWithTrace({ trace_id: 'tr_x' }, () => {
      setTraceFields({ loop_id: 'lp_1' });
      expect(currentTrace()).toMatchObject({ trace_id: 'tr_x', loop_id: 'lp_1' });
    });
  });

  it('setTraceFields 在无上下文时 no-op (不抛)', () => {
    expect(() => setTraceFields({ loop_id: 'lp_1' })).not.toThrow();
  });

  it('上下文跨 await 传播 (AsyncLocalStorage)', async () => {
    await runWithTrace({ trace_id: 'tr_async' }, async () => {
      await Promise.resolve();
      expect(getTraceId()).toBe('tr_async');
    });
  });

  it('嵌套上下文: 内层覆盖, 退出后恢复外层', () => {
    runWithTrace({ trace_id: 'outer' }, () => {
      runWithTrace({ trace_id: 'inner' }, () => {
        expect(getTraceId()).toBe('inner');
      });
      expect(getTraceId()).toBe('outer');
    });
  });
});

describe('logger × trace', () => {
  it('上下文内日志自动带 trace_id', () => {
    const [line] = captureLog(() =>
      runWithTrace({ trace_id: 'tr_log' }, () => log.info({ event: 'e' })),
    );
    expect(JSON.parse(line!)).toMatchObject({ event: 'e', trace_id: 'tr_log' });
  });

  it('上下文外日志不带 trace_id', () => {
    const [line] = captureLog(() => log.info({ event: 'e' }));
    expect(JSON.parse(line!).trace_id).toBeUndefined();
  });

  it('显式 trace_id 字段覆盖 ambient', () => {
    const [line] = captureLog(() =>
      runWithTrace({ trace_id: 'ambient' }, () => log.info({ event: 'e', trace_id: 'explicit' })),
    );
    expect(JSON.parse(line!).trace_id).toBe('explicit');
  });
});
