// trace-context.test.ts — 容器侧 trace_id 隐式透传单测 (bun test)。
// 验证 ALS 语义 + logger 自动并入 trace_id + newTraceId 格式。

import { test, expect, spyOn } from 'bun:test';
import {
  runWithTrace,
  getTraceId,
  currentTrace,
  newTraceId,
} from '../server/trace-context.ts';
import { log } from '../server/logger.ts';

const captureLog = (fn: () => void): string[] => {
  const lines: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((l: unknown) => {
    lines.push(String(l));
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines;
};

test('getTraceId 在上下文内取到, 上下文外为 undefined', () => {
  expect(getTraceId()).toBeUndefined();
  runWithTrace({ trace_id: 'tr_x' }, () => {
    expect(getTraceId()).toBe('tr_x');
    expect(currentTrace()).toMatchObject({ trace_id: 'tr_x' });
  });
  expect(getTraceId()).toBeUndefined();
});

test('上下文跨 await 传播 (含 fire-and-forget 后续)', async () => {
  await runWithTrace({ trace_id: 'tr_async' }, async () => {
    await Promise.resolve();
    expect(getTraceId()).toBe('tr_async');
  });
});

test('newTraceId 形如 tr_<26 hex>', () => {
  expect(newTraceId()).toMatch(/^tr_[0-9a-f]{26}$/);
  expect(newTraceId()).not.toBe(newTraceId()); // 随机
});

test('logger 在上下文内自动带 trace_id', () => {
  const [line] = captureLog(() =>
    runWithTrace({ trace_id: 'tr_log' }, () => log.info({ event: 'e' })),
  );
  expect(JSON.parse(line!)).toMatchObject({ event: 'e', trace_id: 'tr_log' });
});

test('logger 上下文外不带 trace_id', () => {
  const [line] = captureLog(() => log.info({ event: 'e' }));
  expect(JSON.parse(line!).trace_id).toBeUndefined();
});

test('显式 trace_id 覆盖 ambient', () => {
  const [line] = captureLog(() =>
    runWithTrace({ trace_id: 'ambient' }, () => log.info({ event: 'e', trace_id: 'explicit' })),
  );
  expect(JSON.parse(line!).trace_id).toBe('explicit');
});
