import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

import { dao } from '../../src/db/index.js';
import { buildThreadsRouter } from '../../src/api/threads.js';
import { signSession } from '../../src/auth/session.js';
import { requireSession } from '../../src/auth/middleware.js';

const SECRET = 'test-secret-do-not-use-in-prod-123456';
const COOKIE_NAME = 'lingxi_sid';

const validCookie = (userId: string): string => {
  const token = signSession({ user_id: userId }, SECRET, 24);
  return `${COOKIE_NAME}=${token}`;
};

describe('threads CRUD', () => {
  beforeEach(() => {
    vi.mocked(dao.threads.create).mockImplementation(async (row: any) => ({
      id: row.id, user_id: row.user_id, source: row.source, title: row.title,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), archived: false,
    }));
    vi.mocked(dao.threads.listByUser).mockResolvedValue([]);
    vi.mocked(dao.threads.getByIdAndUser).mockResolvedValue(null);
    vi.mocked(dao.threads.deleteById).mockResolvedValue(true);
    vi.mocked(dao.cache.get).mockReturnValue(null);
  });

  const makeApp = () => {
    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    const mw = requireSession({ secret: SECRET, cookieName: COOKIE_NAME });
    app.use(buildThreadsRouter(mw));
    return app;
  };

  it('POST /api/threads creates a thread for current user', async () => {
    const res = await request(makeApp())
      .post('/api/threads')
      .set('Cookie', validCookie('u1'))
      .send({ title: 'first chat' });

    expect(res.status).toBe(200);
    expect(res.body.id).toMatch(/^thr_/);
    expect(res.body.user_id).toBe('u1');
    expect(res.body.source).toBe('web');
    expect(dao.threads.create).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 'u1', source: 'web', title: 'first chat',
    }));
  });

  it('POST /api/threads 401 without session', async () => {
    const res = await request(makeApp()).post('/api/threads').send({});
    expect(res.status).toBe(401);
  });

  it('GET /api/threads returns list for current user', async () => {
    vi.mocked(dao.threads.listByUser).mockResolvedValue([
      { id: 'thr_1', title: 'A', updated_at: '2026-05-30T10:00:00Z', archived: false },
      { id: 'thr_2', title: 'B', updated_at: '2026-05-30T09:00:00Z', archived: false },
    ]);
    const res = await request(makeApp())
      .get('/api/threads')
      .set('Cookie', validCookie('u1'));
    expect(res.status).toBe(200);
    expect(res.body.threads).toHaveLength(2);
    expect(res.body.threads[0].id).toBe('thr_1');
  });

  it('GET /api/threads/:id 404 when not owned by current user', async () => {
    const res = await request(makeApp())
      .get('/api/threads/thr_99')
      .set('Cookie', validCookie('u1'));
    expect(res.status).toBe(404);
  });

  it('GET /api/threads/:id returns the thread when owned', async () => {
    vi.mocked(dao.threads.getByIdAndUser).mockResolvedValue({
      id: 'thr_1', user_id: 'u1', title: 'A', source: 'web', archived: false,
      created_at: 'x', updated_at: 'x',
    } as any);
    const res = await request(makeApp())
      .get('/api/threads/thr_1')
      .set('Cookie', validCookie('u1'));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('thr_1');
  });

  describe('DELETE /api/threads/:id', () => {
    const ownedThread = {
      id: 'thr_1', user_id: 'u1', title: 'A', source: 'web', archived: false,
      created_at: 'x', updated_at: 'x',
    } as any;
    const readyMapping = {
      user_id: 'u1', status: 'ready' as const, container_url: 'http://hermes.test',
    } as any;

    it('returns 404 when thread not owned', async () => {
      vi.mocked(dao.threads.getByIdAndUser).mockResolvedValue(null);
      const res = await request(makeApp())
        .delete('/api/threads/thr_1')
        .set('Cookie', validCookie('u1'));
      expect(res.status).toBe(404);
      expect(dao.threads.deleteById).not.toHaveBeenCalled();
    });

    it('hard-deletes the row when container not ready (skips container call)', async () => {
      vi.mocked(dao.threads.getByIdAndUser).mockResolvedValue(ownedThread);
      vi.mocked(dao.cache.get).mockReturnValue({ ...readyMapping, status: 'provisioning' });
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);
      const res = await request(makeApp())
        .delete('/api/threads/thr_1')
        .set('Cookie', validCookie('u1'));
      expect(res.status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(dao.threads.deleteById).toHaveBeenCalledWith('thr_1', 'u1');
    });

    it('calls container DELETE /session then deletes DB row', async () => {
      vi.mocked(dao.threads.getByIdAndUser).mockResolvedValue(ownedThread);
      vi.mocked(dao.cache.get).mockReturnValue(readyMapping);
      const fetchSpy = vi.fn(async () => new Response(
        JSON.stringify({ ok: true, deleted: true, hermes_session_id: 'sess_xyz' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ));
      vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);
      const res = await request(makeApp())
        .delete('/api/threads/thr_1')
        .set('Cookie', validCookie('u1'));
      expect(res.status).toBe(200);
      // 容器 URL 形如 .../session?session_id=web%3Athr_1
      const callUrl = fetchSpy.mock.calls[0]![0] as string;
      expect(callUrl).toBe('http://hermes.test/session?session_id=web%3Athr_1');
      expect((fetchSpy.mock.calls[0]![1] as RequestInit).method).toBe('DELETE');
      expect(dao.threads.deleteById).toHaveBeenCalledWith('thr_1', 'u1');
    });

    it('still deletes DB row when container call fails (best-effort)', async () => {
      vi.mocked(dao.threads.getByIdAndUser).mockResolvedValue(ownedThread);
      vi.mocked(dao.cache.get).mockReturnValue(readyMapping);
      const fetchSpy = vi.fn(async () => { throw new Error('econnrefused'); });
      vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);
      const res = await request(makeApp())
        .delete('/api/threads/thr_1')
        .set('Cookie', validCookie('u1'));
      expect(res.status).toBe(200);
      expect(dao.threads.deleteById).toHaveBeenCalledWith('thr_1', 'u1');
    });

    it('still deletes DB row when container returns 500', async () => {
      vi.mocked(dao.threads.getByIdAndUser).mockResolvedValue(ownedThread);
      vi.mocked(dao.cache.get).mockReturnValue(readyMapping);
      const fetchSpy = vi.fn(async () => new Response(
        JSON.stringify({ error: 'hermes sessions delete exit 1' }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      ));
      vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);
      const res = await request(makeApp())
        .delete('/api/threads/thr_1')
        .set('Cookie', validCookie('u1'));
      expect(res.status).toBe(200);
      expect(dao.threads.deleteById).toHaveBeenCalledWith('thr_1', 'u1');
    });
  });
});
