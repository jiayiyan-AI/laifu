// resync-endpoint.test.ts — /internal/resync-entitlements handler 单测 (bun test)。
// 直接调 handleResyncEntitlements(req, fakeApply), 注入假 apply 不碰真 FS, 验证:
//   - 解析 body.entitlements 透传给 apply, 响应体回 {observed, token_version}
//   - apply 只在 desired 上调用一次
//   - 非法 JSON → 400
//   - entitlements 缺失 → 当空数组处理

import { test, expect } from 'bun:test';
import { handleResyncEntitlements } from '../server/http.ts';

const makeReq = (body: string): Request =>
  new Request('http://x/internal/resync-entitlements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

test('applies desired and returns observed + token_version', async () => {
  let seen: string[] | null = null;
  const fakeApply = (desired: string[]): string[] => { seen = desired; return ['email']; };
  const res = await handleResyncEntitlements(
    makeReq(JSON.stringify({ entitlements: ['email', 'ghost'], token_version: 7 })),
    fakeApply,
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ observed: ['email'], token_version: 7 });
  expect(seen!).toEqual(['email', 'ghost']);
});

test('invalid JSON → 400, apply not called', async () => {
  let called = false;
  const res = await handleResyncEntitlements(makeReq('not-json'), () => { called = true; return []; });
  expect(res.status).toBe(400);
  expect(called).toBe(false);
});

test('missing entitlements → treated as empty desired', async () => {
  const res = await handleResyncEntitlements(makeReq(JSON.stringify({ token_version: 0 })), (d) => d);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ observed: [], token_version: 0 });
});
