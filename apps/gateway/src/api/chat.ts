import { Router, type Request, type Response, type Router as RouterType, type RequestHandler } from 'express';
import type { WebChatResponse, WebThreadMessagesResponse } from '@lingxi/shared';
import { genId } from '@lingxi/db';
import { dao } from '../db/index.js';
import { dispatchHermesChat } from '../lib/aca-call.js';
import {
  storePendingLoop,
  subscribeLoop,
  unsubscribeLoop,
  emitLoopEvent,
  waitLoopTerminal,
  HARD_DEADLINE_MS,
} from '../lib/pending-loops.js';
import { tryReserveThread, releaseThread } from '../lib/thread-inflight.js';
import { log } from '../lib/logger.js';
import { classifyMessage, runIntercept, type SlashAction } from '../lib/slash-filter.js';

const SSE_HEARTBEAT_MS = 10_000; // gateway→web 心跳间隔（独立于 ACA→gateway 的 2 分钟心跳）

/**
 * 网关拦截到的 slash 命令直接给"inline 回复",**不入库、不计费、不调 Hermes**。
 *
 * 前端拿到 `{ kind: 'inline', reply }` 后把当前 pending 气泡替换成 reply 文本即可。
 * 用户原文也是前端临时显示的(已在 onSend 里 push 进 msgs 但不会持久化) —
 * 刷新页面整段对话即消失,符合 "slash 命令是 transient" 的语义。
 */
const replyInterceptedSlash = async (
  res: Response,
  ctx: {
    userId: string;
    threadId: string;
    action: Extract<SlashAction, { kind: 'intercept' }>;
  },
): Promise<Response> => {
  const reply = await runIntercept(ctx.action, { userId: ctx.userId, threadId: ctx.threadId });
  log.info({
    event: 'chat.slash.intercepted',
    user_id: ctx.userId,
    thread_id: ctx.threadId,
    cmd: ctx.action.cmd,
    log_tag: ctx.action.logTag,
  });
  const body: WebChatResponse = { kind: 'inline', reply };
  return res.json(body);
};

export const buildChatRouter = (
  sessionMw: RequestHandler,
): RouterType => {
  const r = Router();

  r.post('/api/chat', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const { thread_id, message } = (req.body ?? {}) as { thread_id?: string; message?: string };
    if (!thread_id || !message) {
      return res.status(400).json({ error: 'thread_id and message required' });
    }

    // 1. 验证 thread 属于该用户
    const thread = await dao.threads.getByIdAndUser(thread_id, userId);
    if (!thread) return res.status(404).json({ error: 'thread not found' });

    // 1.5 Hermes slash 命令拦截 (详见 lib/slash-filter.ts)
    //   - 拒绝类(/new /reset /model …):网关给静态文案,不调容器,不计费
    //   - 网关自答(/help /version /usage /status):网关查 DB 给确定回复
    //   - 透传(其余 /<word>):落入下方原流程喂给 Hermes
    const slash = classifyMessage(message);
    if (slash.kind === 'intercept') {
      return await replyInterceptedSlash(res, { userId, threadId: thread_id, action: slash });
    }

    // 2. 取该用户的 container url
    const mapping = dao.cache.get(userId);
    if (!mapping || mapping.status !== 'ready' || !mapping.container_url) {
      return res.status(503).json({ error: 'assistant not ready' });
    }

    // 2.5 软配额检查
    try {
      const b = await dao.usage.getBalance(userId);
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

    // 2.6 web 并发兜底: 同 thread 已有 loop 在跑 → 拒(reject-not-queue, 详见 lib/thread-inflight.ts)。
    //     前端 disabled 只挡单标签; 这里兜多标签/多设备/直连 API/reload 竞态。
    if (!tryReserveThread(thread_id)) {
      return res.status(409).json({ error: 'busy', message: '正在处理上一条消息，请稍候。' });
    }

    // 3. 插入 user 消息 + 创建 agent loop
    const userMsgId = genId.message;
    const loopId = genId.agentLoop;
    try {
      await dao.messages.insert({
        id: userMsgId,
        thread_id,
        role: 'user',
        content_type: 'text',
        content: message,
        source: thread.source as 'web' | 'wechat',
      });
      await dao.agentLoops.create({ id: loopId, thread_id, message_id: userMsgId });
    } catch (e) {
      // insert/create 抛错时 loop 尚未注册(storePendingLoop 在后), 无终态信号 → 显式释放占用。
      releaseThread(thread_id);
      throw e;
    }

    // 4. 异步 dispatch（只等 202 ack）
    const sessionId = `${thread.source}:${thread_id}`;
    storePendingLoop(
      { loopId, threadId: thread_id, userId, source: thread.source as 'web' | 'wechat' },
      {
        hardDeadlineMs: HARD_DEADLINE_MS,
        onDeadline: async () => {
          // 用 complete() (WHERE completed_at IS NULL) 标 fail —— 不动 iterated_at,
          // 留给后续晚到的 result callback 通过 recordResult() 翻盘。
          const changed = await dao.agentLoops.complete(loopId, 'fail').catch(() => false);
          if (changed) {
            log.warn({ event: 'loop.deadline.fired', loop_id: loopId, thread_id, user_id: userId });
            emitLoopEvent(loopId, { type: 'fail', error: '响应超时' });
          }
        },
      },
    );
    // loop 终态(成功 / dispatch-fail emit / deadline)统一释放 thread 占用。必须在 storePendingLoop
    // 之后订阅: 此前 loop 未注册, subscribeLoop 会返回已关闭流而立即误释放。
    void waitLoopTerminal(loopId).then(() => releaseThread(thread_id));
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
      await dao.agentLoops.complete(loopId, 'fail');
      // 立刻清掉 pending ctx + deadline timer,避免挂 10min 才 GC
      emitLoopEvent(loopId, { type: 'fail', error: dispatch.error ?? `dispatch failed (${dispatch.status})` });
      return res.status(502).json({ error: dispatch.error ?? `dispatch failed (${dispatch.status})` });
    }

    const body: WebChatResponse = { kind: 'dispatched', user_msg_id: userMsgId, loop_id: loopId };
    res.json(body);
  });

  // 读取 thread 历史消息（查 Postgres）
  r.get('/api/threads/:id/messages', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const threadId = req.params['id'] as string;

    const thread = await dao.threads.getByIdAndUser(threadId, userId);
    if (!thread) return res.status(404).json({ error: 'thread not found' });

    const messages = await dao.messages.listByThread(threadId);
    const body: WebThreadMessagesResponse = { messages };
    res.json(body);
  });

  // 查询 thread 的活跃 loop（前端轮询用）
  r.get('/api/threads/:id/loop', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const threadId = req.params['id'] as string;

    const thread = await dao.threads.getByIdAndUser(threadId, userId);
    if (!thread) return res.status(404).json({ error: 'thread not found' });

    const loop = await dao.agentLoops.getActive(threadId);
    res.json({ loop });
  });

  // Per-loop SSE: 前端发消息后订阅，接收心跳和最终结果
  r.get('/api/loops/:loopId/stream', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const loopId = req.params['loopId'] as string;

    // 校验 loop 归属
    const loop = await dao.agentLoops.getById(loopId);
    if (!loop) return res.status(404).end();
    const thread = await dao.threads.getByIdAndUser(loop.thread_id, userId);
    if (!thread) return res.status(403).end();

    // 若 loop 已完成，直接返回终态事件
    if (loop.completed_at) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      if (loop.completion === 'success' || loop.completion === 'limit') {
        const msgs = await dao.messages.listByThread(loop.thread_id);
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
      const freshLoop = await dao.agentLoops.getById(loopId);
      if (freshLoop?.completed_at) {
        if (freshLoop.completion === 'success' || freshLoop.completion === 'limit') {
          const msgs = await dao.messages.listByThread(freshLoop.thread_id);
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
