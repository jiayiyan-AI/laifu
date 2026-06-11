import { Router, type Request, type Response, type Router as RouterType, type RequestHandler } from 'express';
import type { ContainerMappingCache } from '../db/cache.js';
import type { UsageDao } from '../db/usage-dao.js';
import type { ThreadsDao } from '../db/threads-dao.js';
import type { MessageDao } from '../db/message-dao.js';
import type { AgentLoopDao } from '../db/agent-loop-dao.js';
import type { WebChatResponse, WebThreadMessagesResponse } from '@lingxi/shared';
import { genId } from '@lingxi/db';
import { dispatchHermesChat } from '../lib/aca-call.js';
import { storePendingLoop, subscribeLoop, unsubscribeLoop } from '../lib/pending-loops.js';
import { log } from '../lib/logger.js';

const SSE_HEARTBEAT_MS = 10_000; // gateway→web 心跳间隔（独立于 ACA→gateway 的 2 分钟心跳）

export const buildChatRouter = (
  threadsDao: ThreadsDao,
  cache: ContainerMappingCache,
  sessionMw: RequestHandler,
  usageDao?: UsageDao,
  messageDao?: MessageDao,
  agentLoopDao?: AgentLoopDao,
): RouterType => {
  const r = Router();

  r.post('/api/chat', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const { thread_id, message } = (req.body ?? {}) as { thread_id?: string; message?: string };
    if (!thread_id || !message) {
      return res.status(400).json({ error: 'thread_id and message required' });
    }

    // 1. 验证 thread 属于该用户
    const thread = await threadsDao.getByIdAndUser(thread_id, userId);
    if (!thread) return res.status(404).json({ error: 'thread not found' });

    // 2. 取该用户的 container url
    const mapping = cache.get(userId);
    if (!mapping || mapping.status !== 'ready' || !mapping.container_url) {
      return res.status(503).json({ error: 'assistant not ready' });
    }

    // 2.5 软配额检查
    if (usageDao) {
      try {
        const b = await usageDao.getBalance(userId);
        if (b.used_cny_month >= b.free_quota_cny_month && b.balance_cny <= 0) {
          return res.status(402).json({
            error: 'quota exhausted',
            used_cny_month: b.used_cny_month,
            free_quota_cny_month: b.free_quota_cny_month,
            balance_cny: b.balance_cny,
          });
        }
      } catch (err) {
        log.warn({
          event: 'usage.balance.check.failed',
          user_id: userId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 3. 插入 user 消息 + 创建 agent loop
    const userMsgId = genId.message;
    const loopId = genId.agentLoop;

    if (messageDao) {
      await messageDao.insert({
        id: userMsgId,
        thread_id,
        role: 'user',
        content_type: 'text',
        content: message,
        source: thread.source as 'web' | 'wechat',
      });
    }

    if (agentLoopDao) {
      await agentLoopDao.create({ id: loopId, thread_id, message_id: userMsgId });
    }

    // 4. 异步 dispatch（只等 202 ack）
    const sessionId = `${thread.source}:${thread_id}`;
    storePendingLoop({ loopId, threadId: thread_id, userId, source: thread.source as 'web' | 'wechat' });
    const dispatch = await dispatchHermesChat({
      containerUrl: mapping.container_url,
      userId,
      threadId: thread_id,
      source: thread.source,
      sessionId,
      message,
      loopId,
    });

    if (!dispatch.ok) {
      if (agentLoopDao) {
        await agentLoopDao.complete(loopId, 'fail');
      }
      return res.status(502).json({ error: dispatch.error ?? `dispatch failed (${dispatch.status})` });
    }

    const body: WebChatResponse = { user_msg_id: userMsgId, loop_id: loopId };
    res.json(body);
  });

  // 读取 thread 历史消息（查 Postgres）
  r.get('/api/threads/:id/messages', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const threadId = req.params['id'] as string;

    const thread = await threadsDao.getByIdAndUser(threadId, userId);
    if (!thread) return res.status(404).json({ error: 'thread not found' });

    if (messageDao) {
      const messages = await messageDao.listByThread(threadId);
      const body: WebThreadMessagesResponse = { messages };
      return res.json(body);
    }

    // fallback: 无 messageDao 时返回空（不应在生产中发生）
    res.json({ messages: [] } satisfies WebThreadMessagesResponse);
  });

  // 查询 thread 的活跃 loop（前端轮询用）
  r.get('/api/threads/:id/loop', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const threadId = req.params['id'] as string;

    const thread = await threadsDao.getByIdAndUser(threadId, userId);
    if (!thread) return res.status(404).json({ error: 'thread not found' });

    if (agentLoopDao) {
      const loop = await agentLoopDao.getActive(threadId);
      return res.json({ loop });
    }

    res.json({ loop: null });
  });

  // Per-loop SSE: 前端发消息后订阅，接收心跳和最终结果
  r.get('/api/loops/:loopId/stream', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const loopId = req.params['loopId'] as string;

    if (!agentLoopDao) return res.status(500).end();

    // 校验 loop 归属
    const loop = await agentLoopDao.getById(loopId);
    if (!loop) return res.status(404).end();
    const thread = await threadsDao.getByIdAndUser(loop.thread_id, userId);
    if (!thread) return res.status(403).end();

    // 若 loop 已完成，直接返回终态事件
    if (loop.completed_at) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      if (loop.completion === 'success' || loop.completion === 'limit') {
        // 拉最后一条 assistant 消息作为 reply
        const msgs = messageDao ? await messageDao.listByThread(loop.thread_id) : [];
        const last = msgs.filter(m => m.role === 'assistant').pop();
        const reply = last ? (typeof last.content === 'string' ? last.content : JSON.stringify(last.content)) : '';
        res.write(`event: done\ndata: ${JSON.stringify({ reply, completion: loop.completion })}\n\n`);
      } else {
        res.write(`event: fail\ndata: ${JSON.stringify({ error: 'agent 执行失败' })}\n\n`);
      }
      res.end();
      return;
    }

    // loop 进行中 → 设置 SSE 并订阅
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(': connected\n\n');

    const stream = subscribeLoop(loopId);
    let closed = false;

    // gateway 自主向前端推心跳（10s），让前端有持续反馈
    const heartbeatTimer = setInterval(() => {
      if (closed) return;
      try { res.write(`event: heartbeat\ndata: {}\n\n`); } catch { /* socket dead */ }
    }, SSE_HEARTBEAT_MS);

    req.on('close', () => {
      closed = true;
      clearInterval(heartbeatTimer);
      unsubscribeLoop(loopId, stream);
      res.end();
    });

    // 消费事件流（只关注终态事件，心跳由 timer 自行推送）
    let gotTerminal = false;
    for await (const event of stream) {
      if (closed) break;
      try {
        if (event.type === 'done') {
          res.write(`event: done\ndata: ${JSON.stringify({ reply: event.reply, completion: event.completion })}\n\n`);
          gotTerminal = true;
          break;
        } else if (event.type === 'fail') {
          res.write(`event: fail\ndata: ${JSON.stringify({ error: event.error })}\n\n`);
          gotTerminal = true;
          break;
        }
        // heartbeat from container → 忽略，gateway 自己的 timer 已覆盖
      } catch {
        break;
      }
    }

    // 竞态 fallback：for-await 立即结束（stream 订阅时 ctx 已不在），重查 DB
    if (!gotTerminal && !closed) {
      const freshLoop = await agentLoopDao!.getById(loopId);
      if (freshLoop?.completed_at) {
        if (freshLoop.completion === 'success' || freshLoop.completion === 'limit') {
          const msgs = messageDao ? await messageDao.listByThread(freshLoop.thread_id) : [];
          const last = msgs.filter(m => m.role === 'assistant').pop();
          const reply = last ? (typeof last.content === 'string' ? last.content : JSON.stringify(last.content)) : '';
          res.write(`event: done\ndata: ${JSON.stringify({ reply, completion: freshLoop.completion })}\n\n`);
        } else {
          res.write(`event: fail\ndata: ${JSON.stringify({ error: 'agent 执行失败' })}\n\n`);
        }
      } else {
        // 真正的异常：既没 ctx 也没 DB 完成，发 fail
        res.write(`event: fail\ndata: ${JSON.stringify({ error: '连接中断，请重试' })}\n\n`);
      }
    }

    clearInterval(heartbeatTimer);
    if (!closed) res.end();
  });

  return r;
};
