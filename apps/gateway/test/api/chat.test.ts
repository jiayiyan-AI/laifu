import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { buildChatRouter } from '../../src/api/chat.js';
import { StreamRegistry } from '../../src/chat/stream-registry.js';
import { ContainerMappingCache } from '../../src/db/cache.js';
import { signSession } from '../../src/auth/session.js';
import { requireSession } from '../../src/auth/middleware.js';

const SECRET = 'test-secret-do-not-use-in-prod-123456';
const COOKIE_NAME = 'lingxi_sid';

const validCookie = (userId: string): string => {
  const token = signSession({ user_id: userId }, SECRET, 24);
  return `${COOKIE_NAME}=${token}`;
};

describe('POST /api/chat/start', () => {
  let mockSb: any;
  let cache: ContainerMappingCache;
  let registry: StreamRegistry;
  let fetchSpy: any;

  beforeEach(() => {
    mockSb = {
      from: vi.fn(() => mockSb),
      select: vi.fn(() => mockSb),
      eq: vi.fn(() => mockSb),
      single: vi.fn(() => Promise.resolve({
        data: { id: 'thr_1', user_id: 'u1', source: 'web' },
        error: null,
      })),
      then: (resolve: any) => resolve({ data: null, error: null }),
    };
    cache = new ContainerMappingCache(mockSb);
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
    registry = new StreamRegistry();
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ stream_id: 'inner_xyz' })),
    );
  });

  const makeApp = () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    const mw = requireSession({ secret: SECRET, cookieName: COOKIE_NAME });
    app.use(buildChatRouter(mockSb, cache, registry, mw));
    return app;
  };

  it('returns outer stream_id and calls container start', async () => {
    const res = await request(makeApp())
      .post('/api/chat/start')
      .set('Cookie', validCookie('u1'))
      .send({ thread_id: 'thr_1', message: 'hello' });

    expect(res.status).toBe(200);
    expect(res.body.stream_id).toMatch(/^stm_/);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:8080/api/chat/start',
      expect.objectContaining({ method: 'POST' }),
    );
    const callArgs = fetchSpy.mock.calls[0]![1] as any;
    const body = JSON.parse(callArgs.body);
    expect(body.session_id).toBe('web:thr_1');
    expect(body.message).toBe('hello');
    expect(body.source).toBe('web');

    const entry = registry.resolve(res.body.stream_id);
    expect(entry).toEqual({ containerUrl: 'http://localhost:8080', innerStreamId: 'inner_xyz' });
  });

  it('401 without session', async () => {
    const res = await request(makeApp())
      .post('/api/chat/start')
      .send({ thread_id: 'thr_1', message: 'hello' });
    expect(res.status).toBe(401);
  });

  it('400 when thread_id or message missing', async () => {
    const res = await request(makeApp())
      .post('/api/chat/start')
      .set('Cookie', validCookie('u1'))
      .send({ thread_id: 'thr_1' });
    expect(res.status).toBe(400);
  });

  it('404 when thread not owned by user', async () => {
    mockSb.single = vi.fn(() => Promise.resolve({ data: null, error: { code: 'PGRST116' } }));
    const res = await request(makeApp())
      .post('/api/chat/start')
      .set('Cookie', validCookie('u1'))
      .send({ thread_id: 'thr_999', message: 'hi' });
    expect(res.status).toBe(404);
  });

  it('503 when user has no ready container', async () => {
    cache.delete('u1');
    const res = await request(makeApp())
      .post('/api/chat/start')
      .set('Cookie', validCookie('u1'))
      .send({ thread_id: 'thr_1', message: 'hi' });
    expect(res.status).toBe(503);
  });
});

describe('GET /api/chat/stream', () => {
  let mockSb: any;
  let cache: ContainerMappingCache;
  let registry: StreamRegistry;
  let fetchSpy: any;

  beforeEach(() => {
    mockSb = {
      from: vi.fn(() => mockSb),
      select: vi.fn(() => mockSb),
      eq: vi.fn(() => mockSb),
      single: vi.fn(() => Promise.resolve({
        data: { id: 'thr_1', user_id: 'u1' },
        error: null,
      })),
      then: (resolve: any) => resolve({ data: null, error: null }),
    };
    cache = new ContainerMappingCache(mockSb);
    registry = new StreamRegistry();
  });

  const makeApp = () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    const mw = requireSession({ secret: SECRET, cookieName: COOKIE_NAME });
    app.use(buildChatRouter(mockSb, cache, registry, mw));
    return app;
  };

  it('401 when no session', async () => {
    const res = await request(makeApp()).get('/api/chat/stream?stream_id=stm_x');
    expect(res.status).toBe(401);
  });

  it('404 when stream_id unknown', async () => {
    const res = await request(makeApp())
      .get('/api/chat/stream?stream_id=stm_unknown')
      .set('Cookie', validCookie('u1'));
    expect(res.status).toBe(404);
  });

  it('pipes container SSE bytes through to client', async () => {
    const outer = registry.register({
      containerUrl: 'http://localhost:8080',
      innerStreamId: 'inner_x',
    });

    const sseBody = [
      'event: token\ndata: {"text":"h"}\n\n',
      'event: token\ndata: {"text":"i"}\n\n',
      'event: done\ndata: {"full_reply":"hi","session_id":"web:thr_1"}\n\n',
    ].join('');

    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(sseBody, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );

    const res = await request(makeApp())
      .get(`/api/chat/stream?stream_id=${outer}`)
      .set('Cookie', validCookie('u1'));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toContain('event: token');
    expect(res.text).toContain('event: done');
    expect(res.text).toContain('"text":"h"');

    fetchSpy.mockRestore();
  });
});
