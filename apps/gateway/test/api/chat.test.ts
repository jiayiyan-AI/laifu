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

describe('POST /api/chat', () => {
  let mockSb: any;
  let cache: ContainerMappingCache;
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
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        reply: '你好,我是灵犀',
        session_id: 'web:thr_1',
        exit_code: 0,
      })),
    );
  });

  const makeApp = () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    const mw = requireSession({ secret: SECRET, cookieName: COOKIE_NAME });
    app.use(buildChatRouter(mockSb, cache, mw));
    return app;
  };

  it('returns reply from container with web:thread_id session_id', async () => {
    const res = await request(makeApp())
      .post('/api/chat')
      .set('Cookie', validCookie('u1'))
      .send({ thread_id: 'thr_1', message: 'hello' });

    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('你好,我是灵犀');

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:8080/chat',
      expect.objectContaining({ method: 'POST' }),
    );
    const callArgs = fetchSpy.mock.calls[0]![1] as any;
    const body = JSON.parse(callArgs.body);
    expect(body.session_id).toBe('web:thr_1');
    expect(body.message).toBe('hello');
    expect(body.source).toBe('web');
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
    mockSb.single = vi.fn(() => Promise.resolve({ data: null, error: { code: 'PGRST116' } }));
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

  it('502 when container returns non-OK', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const res = await request(makeApp())
      .post('/api/chat')
      .set('Cookie', validCookie('u1'))
      .send({ thread_id: 'thr_1', message: 'hi' });
    expect(res.status).toBe(502);
  });
});
