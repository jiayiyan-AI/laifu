// auth.test.ts — 容器侧 verifyBearer 验签逻辑单测 (bun test)。
// 纯函数, 显式传 secret + expectedUserId, 不依赖 env / 模块加载顺序。

import { test, expect } from 'bun:test';
import { createHmac } from 'node:crypto';
import { verifyBearer } from '../server/auth.ts';

const SECRET = 'test-secret-1234567890';
const USER = 'u_owner';

const b64url = (buf: Buffer): string => buf.toString('base64url');

const sign = (
  payload: Record<string, unknown>,
  secret: string,
  header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' },
): string => {
  const h = b64url(Buffer.from(JSON.stringify(header)));
  const p = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(createHmac('sha256', secret).update(`${h}.${p}`).digest());
  return `${h}.${p}.${sig}`;
};

const future = Math.floor(Date.now() / 1000) + 3600;
const past = Math.floor(Date.now() / 1000) - 3600;

test('valid token for the expected user → returns claims', () => {
  const token = sign({ user_id: USER, token_version: 0, exp: future }, SECRET);
  const claims = verifyBearer(token, SECRET, USER);
  expect(claims?.user_id).toBe(USER);
});

test('valid token, no expectedUserId constraint → returns claims', () => {
  const token = sign({ user_id: 'anyone', exp: future }, SECRET);
  expect(verifyBearer(token, SECRET, null)?.user_id).toBe('anyone');
});

test('wrong secret → null', () => {
  const token = sign({ user_id: USER, exp: future }, 'other-secret');
  expect(verifyBearer(token, SECRET, USER)).toBeNull();
});

test('expired token → null', () => {
  const token = sign({ user_id: USER, exp: past }, SECRET);
  expect(verifyBearer(token, SECRET, USER)).toBeNull();
});

test('user_id mismatch → null', () => {
  const token = sign({ user_id: 'u_other', exp: future }, SECRET);
  expect(verifyBearer(token, SECRET, USER)).toBeNull();
});

test('tampered payload (sig no longer matches) → null', () => {
  const token = sign({ user_id: USER, exp: future }, SECRET);
  const [h, , s] = token.split('.');
  const forged = b64url(Buffer.from(JSON.stringify({ user_id: 'u_attacker', exp: future })));
  expect(verifyBearer(`${h}.${forged}.${s}`, SECRET, null)).toBeNull();
});

test('alg confusion (alg:none, empty sig) → null', () => {
  const h = b64url(Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })));
  const p = b64url(Buffer.from(JSON.stringify({ user_id: USER, exp: future })));
  expect(verifyBearer(`${h}.${p}.`, SECRET, USER)).toBeNull();
});

test('malformed token (not 3 segments) → null', () => {
  expect(verifyBearer('not-a-jwt', SECRET, null)).toBeNull();
  expect(verifyBearer('a.b', SECRET, null)).toBeNull();
});
