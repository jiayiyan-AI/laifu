import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

import { dao } from '../../src/db/index.js';
import { buildChatRouter } from '../../src/api/chat.js';
import { signSession } from '../../src/auth/session.js';
import { requireSession } from '../../src/auth/middleware.js';
import {
  __resetThreadInflightForTests,
  isThreadReserved,
} from '../../src/lib/thread-inflight.js';
import { emitLoopEvent, __resetPendingLoopsForTests } from '../../src/lib/pending-loops.js';

const SECRET = 'test-secret-do-not-use-in-prod-123456';
const COOKIE_NAME = 'lingxi_sid';

const validCookie = (userId: string): string => {
  const token = signSession({ user_id: userId }, SECRET, 24);
  return `${COOKIE_NAME}=${token}`;
};

describe('POST /api/chat', () => {
  let fetchSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetThreadInflightForTests();
    __resetPendingLoopsForTests();
    vi.mocked(dao.threads.getByIdAndUser).mockResolvedValue({ id: 'thr_1', user_id: 'u1', source: 'web' } as any);
    vi.mocked(dao.cache.get).mockReturnValue({
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
    } as any);
    vi.mocked(dao.usage.getBalance).mockResolvedValue({
      balance_cny: 10, free_quota_cny_month: 5, used_cny_month: 0, period_start: '2026-01-01',
    });
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ accepted: true }), { status: 202 }),
    );
  });

  const makeApp = () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    const mw = requireSession({ secret: SECRET, cookieName: COOKIE_NAME });
    app.use(buildChatRouter(mw));
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

    expect(dao.messages.insert).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user', content: 'hello', source: 'web' }),
    );

    expect(dao.agentLoops.create).toHaveBeenCalledWith(
      expect.objectContaining({ thread_id: 'thr_1' }),
    );

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
    vi.mocked(dao.threads.getByIdAndUser).mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/chat')
      .set('Cookie', validCookie('u1'))
      .send({ thread_id: 'thr_999', message: 'hi' });
    expect(res.status).toBe(404);
  });

  it('503 when user has no ready container', async () => {
    vi.mocked(dao.cache.get).mockReturnValue(null);
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
    expect(dao.agentLoops.complete).toHaveBeenCalledWith(expect.any(String), 'fail');
  });

  it('409 when同 thread 已有 loop 在跑 (busy-reject)', async () => {
    const app = makeApp();
    // 第一条: 占用 thr_1 (dispatch 202, loop 未终态 → 占用不释放)
    const first = await request(app)
      .post('/api/chat')
      .set('Cookie', validCookie('u1'))
      .send({ thread_id: 'thr_1', message: 'first' });
    expect(first.status).toBe(200);
    expect(isThreadReserved('thr_1')).toBe(true);

    // 第二条同 thread: 拒
    const second = await request(app)
      .post('/api/chat')
      .set('Cookie', validCookie('u1'))
      .send({ thread_id: 'thr_1', message: 'second' });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('busy');
    // 第二条不写库不 dispatch
    expect(dao.messages.insert).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('loop 终态后释放占用, 同 thread 可再发', async () => {
    const app = makeApp();
    const first = await request(app)
      .post('/api/chat')
      .set('Cookie', validCookie('u1'))
      .send({ thread_id: 'thr_1', message: 'first' });
    expect(first.status).toBe(200);
    // loop 终态 → waitLoopTerminal 释放
    emitLoopEvent(first.body.loop_id, { type: 'done', reply: 'ok', completion: 'success' });
    await new Promise((r) => setTimeout(r, 0));
    expect(isThreadReserved('thr_1')).toBe(false);

    const second = await request(app)
      .post('/api/chat')
      .set('Cookie', validCookie('u1'))
      .send({ thread_id: 'thr_1', message: 'second' });
    expect(second.status).toBe(200);
  });

  it('dispatch 失败即释放占用 (不留死锁)', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const res = await request(makeApp())
      .post('/api/chat')
      .set('Cookie', validCookie('u1'))
      .send({ thread_id: 'thr_1', message: 'hi' });
    expect(res.status).toBe(502);
    await Promise.resolve();
    expect(isThreadReserved('thr_1')).toBe(false);
  });

  it('intercepts /new with inline reply, no Hermes, no DB write', async () => {
    const res = await request(makeApp())
      .post('/api/chat')
      .set('Cookie', validCookie('u1'))
      .send({ thread_id: 'thr_1', message: '/new' });

    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('inline');
    expect(res.body.reply).toMatch(/新对话/);
    // 容器侧从未被调用
    expect(fetchSpy).not.toHaveBeenCalled();
    // 不入库 — 既不写 user msg 也不写 assistant msg, 也不建 loop
    expect(dao.messages.insert).not.toHaveBeenCalled();
    expect(dao.agentLoops.create).not.toHaveBeenCalled();
    expect(dao.agentLoops.recordResult).not.toHaveBeenCalled();
  });

  it('intercepts /help with inline gateway-rendered text', async () => {
    const res = await request(makeApp())
      .post('/api/chat')
      .set('Cookie', validCookie('u1'))
      .send({ thread_id: 'thr_1', message: '/help' });

    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('inline');
    expect(res.body.reply).toMatch(/灵犀可用指令/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(dao.messages.insert).not.toHaveBeenCalled();
  });

  it('intercepts /usage inline with balance from DAO', async () => {
    vi.mocked(dao.usage.getBalance).mockResolvedValueOnce({
      balance_cny: 12.34, free_quota_cny_month: 50, used_cny_month: 7.89, period_start: '2026-06-01',
    });
    const res = await request(makeApp())
      .post('/api/chat')
      .set('Cookie', validCookie('u1'))
      .send({ thread_id: 'thr_1', message: '/usage' });

    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('inline');
    expect(res.body.reply).toMatch(/¥7\.89/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(dao.messages.insert).not.toHaveBeenCalled();
  });

  it('forwards unknown /<word> to Hermes (forward branch)', async () => {
    const res = await request(makeApp())
      .post('/api/chat')
      .set('Cookie', validCookie('u1'))
      .send({ thread_id: 'thr_1', message: '/some-random-skill 参数' });

    expect(res.status).toBe(200);
    // 走原 dispatch 链路 — fetch 被调
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    expect(body.message).toBe('/some-random-skill 参数');
    // 没创建第二条 assistant 消息(那是 callback 的事,这里只校验 dispatch 阶段)
    expect(dao.messages.insert).toHaveBeenCalledTimes(1);
    expect(dao.agentLoops.recordResult).not.toHaveBeenCalled();
  });

  it('does NOT misidentify /etc/hosts as slash command', async () => {
    const res = await request(makeApp())
      .post('/api/chat')
      .set('Cookie', validCookie('u1'))
      .send({ thread_id: 'thr_1', message: '/etc/hosts 是什么文件' });

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/threads/:id/messages', () => {
  beforeEach(() => {
    vi.mocked(dao.threads.getByIdAndUser).mockResolvedValue({ id: 'thr_1', user_id: 'u1', source: 'web' } as any);
    vi.mocked(dao.messages.listByThread).mockResolvedValue([
      { id: 'msg_1', thread_id: 'thr_1', role: 'user', content_type: 'text', content: 'hi', source: 'web', created_at: '2025-01-01T00:00:00Z' },
      { id: 'msg_2', thread_id: 'thr_1', role: 'assistant', content_type: 'text', content: 'hello', source: 'web', created_at: '2025-01-01T00:00:01Z' },
    ]);
  });

  const makeApp = () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    const mw = requireSession({ secret: SECRET, cookieName: COOKIE_NAME });
    app.use(buildChatRouter(mw));
    return app;
  };

  it('returns messages from Postgres (not container)', async () => {
    const res = await request(makeApp())
      .get('/api/threads/thr_1/messages')
      .set('Cookie', validCookie('u1'));

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.messages[0]).toMatchObject({ id: 'msg_1', role: 'user', content: 'hi' });
    expect(dao.messages.listByThread).toHaveBeenCalledWith('thr_1');
  });

  it('401 without session', async () => {
    const res = await request(makeApp()).get('/api/threads/thr_1/messages');
    expect(res.status).toBe(401);
  });

  it('404 when thread not owned by user', async () => {
    vi.mocked(dao.threads.getByIdAndUser).mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/threads/thr_999/messages')
      .set('Cookie', validCookie('u1'));
    expect(res.status).toBe(404);
  });
});

describe('GET /api/threads/:id/loop', () => {
  beforeEach(() => {
    vi.mocked(dao.threads.getByIdAndUser).mockResolvedValue({ id: 'thr_1', user_id: 'u1', source: 'web' } as any);
    vi.mocked(dao.agentLoops.getActive).mockResolvedValue({
      id: 'loop_1', thread_id: 'thr_1', message_id: 'msg_1',
      completion: null, created_at: '2025-01-01T00:00:00Z', completed_at: null,
    });
  });

  const makeApp = () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    const mw = requireSession({ secret: SECRET, cookieName: COOKIE_NAME });
    app.use(buildChatRouter(mw));
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
    vi.mocked(dao.agentLoops.getActive).mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/threads/thr_1/loop')
      .set('Cookie', validCookie('u1'));

    expect(res.status).toBe(200);
    expect(res.body.loop).toBeNull();
  });
});
