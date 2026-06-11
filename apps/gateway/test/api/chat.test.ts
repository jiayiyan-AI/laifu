import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { buildChatRouter } from '../../src/api/chat.js';
import { ContainerMappingCache } from '../../src/db/cache.js';
import { signSession } from '../../src/auth/session.js';
import { requireSession } from '../../src/auth/middleware.js';

const SECRET = 'test-secret-do-not-use-in-prod-123456';
const COOKIE_NAME = 'lingxi_sid';

const validCookie = (userId: string): string => {
  const token = signSession({ user_id: userId }, SECRET, 24);
  return `${COOKIE_NAME}=${token}`;
};

const mockDbForCache = { select: vi.fn(() => ({ from: vi.fn(() => Promise.resolve([])) })) };

describe('POST /api/chat', () => {
  let mockThreadsDao: any;
  let mockMessageDao: any;
  let mockAgentLoopDao: any;
  let cache: ContainerMappingCache;
  let fetchSpy: any;

  beforeEach(() => {
    mockThreadsDao = {
      create: vi.fn(),
      listByUser: vi.fn(),
      getByIdAndUser: vi.fn(async () => ({ id: 'thr_1', user_id: 'u1', source: 'web' })),
      archive: vi.fn(),
    };
    mockMessageDao = {
      insert: vi.fn(async () => {}),
      listByThread: vi.fn(async () => []),
    };
    mockAgentLoopDao = {
      create: vi.fn(async () => {}),
      complete: vi.fn(async () => true),
      getById: vi.fn(async () => null),
      getActive: vi.fn(async () => null),
      reapStale: vi.fn(async () => 0),
    };
    cache = new ContainerMappingCache(mockDbForCache as any);
    cache.set({
      user_id: 'u1',
      container_name: 'hermes-u1',
      container_url: 'http://localhost:8080',
      status: 'ready',
      provisioning_step: null,
      progress_pct: 100,
      error_message: null,
      azure_files_share: 'user-u1',
      created_at: new Date().toISOString(),
      ready_at: new Date().toISOString(),
    });
    // Dispatch returns 202
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ accepted: true }), { status: 202 }),
    );
  });

  const makeApp = () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    const mw = requireSession({ secret: SECRET, cookieName: COOKIE_NAME });
    app.use(buildChatRouter(mockThreadsDao, cache, mw, undefined, mockMessageDao, mockAgentLoopDao));
    return app;
  };

  it('returns user_msg_id and loop_id after async dispatch', async () => {
    const res = await request(makeApp())
      .post('/api/chat')
      .set('Cookie', validCookie('u1'))
      .send({ thread_id: 'thr_1', message: 'hello' });

    expect(res.status).toBe(200);
    expect(res.body.user_msg_id).toMatch(/^msg_/);
    expect(res.body.loop_id).toMatch(/^lp_/);

    // user message inserted
    expect(mockMessageDao.insert).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user', content: 'hello', source: 'web' }),
    );

    // agent loop created
    expect(mockAgentLoopDao.create).toHaveBeenCalledWith(
      expect.objectContaining({ thread_id: 'thr_1' }),
    );

    // dispatch called with callback
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:8080/chat',
      expect.objectContaining({ method: 'POST' }),
    );
    const callArgs = fetchSpy.mock.calls[0]![1] as any;
    const body = JSON.parse(callArgs.body);
    expect(body.session_id).toBe('web:thr_1');
    expect(body.message).toBe('hello');
    expect(body.source).toBe('web');
    expect(body.callback.loop_id).toMatch(/^lp_/);
  });

  it('401 without session', async () => {
    const res = await request(makeApp())
      .post('/api/chat')
      .send({ thread_id: 'thr_1', message: 'hello' });
    expect(res.status).toBe(401);
  });

  it('400 when thread_id or message missing', async () => {
    const res = await request(makeApp())
      .post('/api/chat')
      .set('Cookie', validCookie('u1'))
      .send({ thread_id: 'thr_1' });
    expect(res.status).toBe(400);
  });

  it('404 when thread not owned by user', async () => {
    mockThreadsDao.getByIdAndUser.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/chat')
      .set('Cookie', validCookie('u1'))
      .send({ thread_id: 'thr_999', message: 'hi' });
    expect(res.status).toBe(404);
  });

  it('503 when user has no ready container', async () => {
    cache.delete('u1');
    const res = await request(makeApp())
      .post('/api/chat')
      .set('Cookie', validCookie('u1'))
      .send({ thread_id: 'thr_1', message: 'hi' });
    expect(res.status).toBe(503);
  });

  it('502 when dispatch fails (non-202)', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const res = await request(makeApp())
      .post('/api/chat')
      .set('Cookie', validCookie('u1'))
      .send({ thread_id: 'thr_1', message: 'hi' });
    expect(res.status).toBe(502);
    // loop marked as fail
    expect(mockAgentLoopDao.complete).toHaveBeenCalledWith(expect.any(String), 'fail');
  });
});

describe('GET /api/threads/:id/messages', () => {
  let mockThreadsDao: any;
  let mockMessageDao: any;
  let mockAgentLoopDao: any;
  let cache: ContainerMappingCache;

  beforeEach(() => {
    mockThreadsDao = {
      create: vi.fn(),
      listByUser: vi.fn(),
      getByIdAndUser: vi.fn(async () => ({ id: 'thr_1', user_id: 'u1', source: 'web' })),
      archive: vi.fn(),
    };
    mockMessageDao = {
      insert: vi.fn(async () => {}),
      listByThread: vi.fn(async () => [
        { id: 'msg_1', thread_id: 'thr_1', role: 'user', content_type: 'text', content: 'hi', source: 'web', created_at: '2025-01-01T00:00:00Z' },
        { id: 'msg_2', thread_id: 'thr_1', role: 'assistant', content_type: 'text', content: 'hello', source: 'web', created_at: '2025-01-01T00:00:01Z' },
      ]),
    };
    mockAgentLoopDao = {
      create: vi.fn(async () => {}),
      complete: vi.fn(async () => true),
      getById: vi.fn(async () => null),
      getActive: vi.fn(async () => null),
      reapStale: vi.fn(async () => 0),
    };
    cache = new ContainerMappingCache(mockDbForCache as any);
    cache.set({
      user_id: 'u1',
      container_name: 'hermes-u1',
      container_url: 'http://localhost:8080',
      status: 'ready',
      provisioning_step: null,
      progress_pct: 100,
      error_message: null,
      azure_files_share: 'user-u1',
      created_at: new Date().toISOString(),
      ready_at: new Date().toISOString(),
    });
  });

  const makeApp = () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    const mw = requireSession({ secret: SECRET, cookieName: COOKIE_NAME });
    app.use(buildChatRouter(mockThreadsDao, cache, mw, undefined, mockMessageDao, mockAgentLoopDao));
    return app;
  };

  it('returns messages from Postgres (not container)', async () => {
    const res = await request(makeApp())
      .get('/api/threads/thr_1/messages')
      .set('Cookie', validCookie('u1'));

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.messages[0]).toMatchObject({ id: 'msg_1', role: 'user', content: 'hi' });
    expect(mockMessageDao.listByThread).toHaveBeenCalledWith('thr_1');
  });

  it('401 without session', async () => {
    const res = await request(makeApp()).get('/api/threads/thr_1/messages');
    expect(res.status).toBe(401);
  });

  it('404 when thread not owned by user', async () => {
    mockThreadsDao.getByIdAndUser.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/threads/thr_999/messages')
      .set('Cookie', validCookie('u1'));
    expect(res.status).toBe(404);
  });
});

describe('GET /api/threads/:id/loop', () => {
  let mockThreadsDao: any;
  let mockMessageDao: any;
  let mockAgentLoopDao: any;
  let cache: ContainerMappingCache;

  beforeEach(() => {
    mockThreadsDao = {
      create: vi.fn(),
      listByUser: vi.fn(),
      getByIdAndUser: vi.fn(async () => ({ id: 'thr_1', user_id: 'u1', source: 'web' })),
      archive: vi.fn(),
    };
    mockMessageDao = {
      insert: vi.fn(async () => {}),
      listByThread: vi.fn(async () => []),
    };
    mockAgentLoopDao = {
      create: vi.fn(async () => {}),
      complete: vi.fn(async () => true),
      getById: vi.fn(async () => null),
      getActive: vi.fn(async () => ({
        id: 'loop_1', thread_id: 'thr_1', message_id: 'msg_1',
        completion: null, created_at: '2025-01-01T00:00:00Z', completed_at: null,
      })),
      reapStale: vi.fn(async () => 0),
    };
    cache = new ContainerMappingCache(mockDbForCache as any);
  });

  const makeApp = () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    const mw = requireSession({ secret: SECRET, cookieName: COOKIE_NAME });
    app.use(buildChatRouter(mockThreadsDao, cache, mw, undefined, mockMessageDao, mockAgentLoopDao));
    return app;
  };

  it('returns active loop', async () => {
    const res = await request(makeApp())
      .get('/api/threads/thr_1/loop')
      .set('Cookie', validCookie('u1'));

    expect(res.status).toBe(200);
    expect(res.body.loop).toMatchObject({ id: 'loop_1', completion: null });
  });

  it('returns null when no active loop', async () => {
    mockAgentLoopDao.getActive.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/threads/thr_1/loop')
      .set('Cookie', validCookie('u1'));

    expect(res.status).toBe(200);
    expect(res.body.loop).toBeNull();
  });
});
