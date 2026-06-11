import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
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
  let mockDao: any;

  beforeEach(() => {
    mockDao = {
      create: vi.fn(async (row: any) => ({
        id: row.id, user_id: row.user_id, source: row.source, title: row.title,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(), archived: false,
      })),
      listByUser: vi.fn(async () => []),
      getByIdAndUser: vi.fn(async () => null),
      archive: vi.fn(async () => {}),
    };
  });

  const makeApp = () => {
    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    const mw = requireSession({ secret: SECRET, cookieName: COOKIE_NAME });
    app.use(buildThreadsRouter(mockDao, mw));
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
    expect(mockDao.create).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 'u1', source: 'web', title: 'first chat',
    }));
  });

  it('POST /api/threads 401 without session', async () => {
    const res = await request(makeApp()).post('/api/threads').send({});
    expect(res.status).toBe(401);
  });

  it('GET /api/threads returns list for current user', async () => {
    mockDao.listByUser.mockResolvedValue([
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
    mockDao.getByIdAndUser.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/threads/thr_99')
      .set('Cookie', validCookie('u1'));
    expect(res.status).toBe(404);
  });

  it('GET /api/threads/:id returns the thread when owned', async () => {
    mockDao.getByIdAndUser.mockResolvedValue({
      id: 'thr_1', user_id: 'u1', title: 'A', source: 'web', archived: false,
      created_at: 'x', updated_at: 'x',
    });
    const res = await request(makeApp())
      .get('/api/threads/thr_1')
      .set('Cookie', validCookie('u1'));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('thr_1');
  });

  it('DELETE /api/threads/:id archives instead of hard delete', async () => {
    const res = await request(makeApp())
      .delete('/api/threads/thr_1')
      .set('Cookie', validCookie('u1'));
    expect(res.status).toBe(200);
    expect(mockDao.archive).toHaveBeenCalledWith('thr_1', 'u1');
  });
});
