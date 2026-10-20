import { describe, it, expect, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import express from 'express';
import request from 'supertest';
import { makeSessionVersionStore, issueSessionCookie, sessionVersions } from '../../src/auth/session-version.js';

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

import { dao } from '../../src/db/index.js';

describe('makeSessionVersionStore', () => {
  it('TTL 内命中缓存, 不重复查库', async () => {
    const fetch = vi.fn(async () => 2);
    let t = 0;
    const s = makeSessionVersionStore(fetch, { ttlMs: 30_000, now: () => t });
    expect(await s.get('u1')).toBe(2);
    t = 29_999;
    expect(await s.get('u1')).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('TTL 过后重新查库', async () => {
    const fetch = vi.fn(async () => 2);
    let t = 0;
    const s = makeSessionVersionStore(fetch, { ttlMs: 30_000, now: () => t });
    await s.get('u1');
    t = 30_001;
    await s.get('u1');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('invalidate 后立即重新查库', async () => {
    const fetch = vi.fn(async () => 2);
    const s = makeSessionVersionStore(fetch, { ttlMs: 30_000, now: () => 0 });
    await s.get('u1');
    s.invalidate('u1');
    await s.get('u1');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('invalidate 期间在途的旧查询结果不回写缓存 (竞态)', async () => {
    let resolveFirst!: (v: number) => void;
    const fetch = vi.fn()
      .mockImplementationOnce(() => new Promise<number>((r) => { resolveFirst = r; }))
      .mockResolvedValue(3);
    const s = makeSessionVersionStore(fetch, { ttlMs: 30_000, now: () => 0 });
    const pending = s.get('u1');      // 改密码前发起的查询, 尚未返回
    s.invalidate('u1');               // 改密码: sv 已 +1, 清缓存
    resolveFirst(2);                  // 旧查询带着旧值 2 返回
    expect(await pending).toBe(2);    // 本次调用仍拿到自己查到的值
    expect(await s.get('u1')).toBe(3); // 但不能把旧值写回缓存, 下一次必须重新查库
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('用户不存在(null)不缓存', async () => {
    const fetch = vi.fn(async () => null);
    const s = makeSessionVersionStore(fetch, { ttlMs: 30_000, now: () => 0 });
    expect(await s.get('u1')).toBeNull();
    await s.get('u1');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('issueSessionCookie', () => {
  const SECRET = 'test-secret-do-not-use-in-prod-123456';
  const opts = { sessionSecret: SECRET, cookieName: 'sid', ttlHours: 1 };
  const svOf = async (userId: string, sv?: number) => {
    const app = express();
    app.get('/', async (_req, res) => {
      await issueSessionCookie(res, userId, opts, sv);
      res.json({ ok: true });
    });
    const res = await request(app).get('/');
    const raw = String(res.headers['set-cookie']?.[0] ?? '');
    const token = /^sid=([^;]+)/.exec(raw)![1]!;
    return (jwt.verify(token, SECRET) as { user_id: string; sv: number });
  };

  it('显式 sv=7 → JWT 带 sv=7', async () => {
    expect(await svOf('u_x', 7)).toMatchObject({ user_id: 'u_x', sv: 7 });
  });

  it('不传 sv → 取 store 里的当前值', async () => {
    sessionVersions.invalidate('u_y');
    vi.mocked(dao.users.getSessionVersion).mockResolvedValue(5);
    expect(await svOf('u_y')).toMatchObject({ user_id: 'u_y', sv: 5 });
  });
});
