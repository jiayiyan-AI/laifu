/**
 * 覆盖 task.md 第 6 节 (Tests) 列的三个核心场景:
 *   1. late callback wins —— deadline 已先标 fail, 后到的 result 仍能反转 + 写入 assistant 消息
 *   2. 重复 callback 幂等 —— 第二次 recordResult 0 rows → already_committed, 不重插
 *   3. deadline timer —— storePendingLoop 之后 advanceTimersByTime 触发 onDeadline
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express, { type Express, type RequestHandler } from 'express';
import type { HermesCallbackResult } from '@lingxi/shared';

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

import { dao } from '../../src/db/index.js';
import { buildCallbackRouter } from '../../src/api/internal-callback.js';
import {
  storePendingLoop,
  subscribeLoop,
  unsubscribeLoop,
  emitLoopEvent,
  hasPendingLoop,
  __resetPendingLoopsForTests,
  HARD_DEADLINE_MS,
} from '../../src/lib/pending-loops.js';

// 测试用 stub container-auth: 从 header 取 user_id, 不验签
const stubAuth: RequestHandler = (req, _res, next) => {
  const uid = req.headers['x-test-user'];
  req.user_id = typeof uid === 'string' ? uid : 'u1';
  next();
};

const makeApp = (): Express => {
  const app = express();
  app.use(express.json());
  app.use(buildCallbackRouter({ containerAuth: stubAuth }));
  return app;
};

const resultBody = (loopId: string, reply: string): HermesCallbackResult => ({
  type: 'result',
  loop_id: loopId,
  reply,
  exit_code: 0,
});


describe('POST /internal/hermes-callback — result latch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetPendingLoopsForTests();
    vi.mocked(dao.agentLoops.recordResult).mockResolvedValue(true);
    vi.mocked(dao.threads.getByIdAndUser).mockResolvedValue({
      id: 'thr_1',
      user_id: 'u1',
      source: 'web',
      title: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      archived: false,
    });
  });

  afterEach(() => {
    __resetPendingLoopsForTests();
  });

  it('late callback wins after deadline already marked fail', async () => {
    // ─ arrange: deadline 已经跑过 complete(fail), 现在到 result callback
    // recordResult 仍能 win (因为 iterated_at 还是 NULL)
    vi.mocked(dao.agentLoops.getById).mockResolvedValue({
      id: 'lp_late',
      thread_id: 'thr_1',
      message_id: 'msg_in',
      completion: 'fail',
      created_at: '2026-01-01T00:00:00Z',
      completed_at: '2026-01-01T00:05:00Z',
    });
    vi.mocked(dao.agentLoops.recordResult).mockResolvedValue(true);

    // ─ act
    const res = await request(makeApp())
      .post('/internal/hermes-callback')
      .set('x-test-user', 'u1')
      .send(resultBody('lp_late', '迟到的回复'));

    // ─ assert: 200, assistant 消息入库, recordResult 被调
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(dao.agentLoops.recordResult).toHaveBeenCalledWith('lp_late', 'success');
    expect(dao.messages.insert).toHaveBeenCalledWith(expect.objectContaining({
      thread_id: 'thr_1',
      role: 'assistant',
      content: '迟到的回复',
    }));
  });

  it('duplicate result callback is idempotent (already_committed)', async () => {
    vi.mocked(dao.agentLoops.getById).mockResolvedValue({
      id: 'lp_dup',
      thread_id: 'thr_1',
      message_id: 'msg_in',
      completion: 'success',
      created_at: '2026-01-01T00:00:00Z',
      completed_at: '2026-01-01T00:01:00Z',
    });
    // 第一次抢到 latch, 第二次 0 rows
    vi.mocked(dao.agentLoops.recordResult)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const app = makeApp();
    const first = await request(app)
      .post('/internal/hermes-callback')
      .set('x-test-user', 'u1')
      .send(resultBody('lp_dup', '主回复'));
    const second = await request(app)
      .post('/internal/hermes-callback')
      .set('x-test-user', 'u1')
      .send(resultBody('lp_dup', '主回复'));

    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ok: true, already_committed: true });

    // 只插一条
    expect(dao.messages.insert).toHaveBeenCalledTimes(1);
  });
});

describe('storePendingLoop — hard deadline timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetPendingLoopsForTests();
  });

  afterEach(() => {
    __resetPendingLoopsForTests();
    vi.useRealTimers();
  });

  it('fires onDeadline after HARD_DEADLINE_MS elapses', async () => {
    const onDeadline = vi.fn(async () => {});
    storePendingLoop(
      { loopId: 'lp_timer', threadId: 'thr_1', userId: 'u1', source: 'web' },
      { hardDeadlineMs: HARD_DEADLINE_MS, onDeadline },
    );

    expect(hasPendingLoop('lp_timer')).toBe(true);
    expect(onDeadline).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HARD_DEADLINE_MS + 1);
    expect(onDeadline).toHaveBeenCalledTimes(1);
  });

  it('SSE subscriber receives fail when onDeadline emits via pending-loops', async () => {
    // 模拟真实路径: onDeadline 通过 emitLoopEvent 推 fail
    storePendingLoop(
      { loopId: 'lp_sse_timer', threadId: 'thr_1', userId: 'u1', source: 'web' },
      {
        hardDeadlineMs: HARD_DEADLINE_MS,
        onDeadline: async () => {
          emitLoopEvent('lp_sse_timer', { type: 'fail', error: '响应超时' });
        },
      },
    );

    const stream = subscribeLoop('lp_sse_timer');
    const iter = stream[Symbol.asyncIterator]();

    await vi.advanceTimersByTimeAsync(HARD_DEADLINE_MS + 1);

    const next = await iter.next();
    expect(next.done).toBe(false);
    expect(next.value).toEqual({ type: 'fail', error: '响应超时' });

    // 终态后 ctx 被清, stream 已关闭
    expect(hasPendingLoop('lp_sse_timer')).toBe(false);
    unsubscribeLoop('lp_sse_timer', stream);
  });
});

describe('POST /internal/hermes-callback — feishuReplier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetPendingLoopsForTests();
    vi.mocked(dao.agentLoops.recordResult).mockResolvedValue(true);
  });

  afterEach(() => {
    __resetPendingLoopsForTests();
  });

  it('source=feishu 时调用 feishuReplier(threadId, reply)', async () => {
    const feishuReplier = vi.fn(async () => {});
    const app = express();
    app.use(express.json());
    app.use(buildCallbackRouter({ containerAuth: stubAuth, feishuReplier }));

    storePendingLoop(
      { loopId: 'lp_feishu', threadId: 'thr_feishu', userId: 'u1', source: 'feishu' },
      { hardDeadlineMs: 60_000, onDeadline: async () => {} },
    );

    const res = await request(app)
      .post('/internal/hermes-callback')
      .set('x-test-user', 'u1')
      .send(resultBody('lp_feishu', '飞书回复内容'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    // 给 fire-and-forget 一个 tick
    await new Promise((r) => setTimeout(r, 10));
    expect(feishuReplier).toHaveBeenCalledTimes(1);
    expect(feishuReplier).toHaveBeenCalledWith('thr_feishu', '飞书回复内容');
  });
});

describe('POST /internal/hermes-callback — 心跳保活回敲 /health', () => {
  beforeEach(() => {
    __resetPendingLoopsForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('心跳 + 容器 ready → 回敲 container_url/health (保活 KEDA)', async () => {
    vi.mocked(dao.cache.get).mockReturnValue({
      user_id: 'u1', status: 'ready', container_url: 'http://c.local',
    } as never);
    const f = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', f);

    const res = await request(makeApp())
      .post('/internal/hermes-callback')
      .set('x-test-user', 'u1')
      .send({ type: 'heartbeat', loop_id: 'lp_hb' });

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(f).toHaveBeenCalled());
    expect(vi.mocked(f).mock.calls[0]?.[0]).toBe('http://c.local/health');
  });

  it('心跳 + 容器未 ready (cache miss) → 不回敲', async () => {
    vi.mocked(dao.cache.get).mockReturnValue(null);
    const f = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', f);

    const res = await request(makeApp())
      .post('/internal/hermes-callback')
      .set('x-test-user', 'u1')
      .send({ type: 'heartbeat', loop_id: 'lp_hb2' });

    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 10)); // 给 fire-and-forget 一个 tick
    expect(f).not.toHaveBeenCalled();
  });
});
