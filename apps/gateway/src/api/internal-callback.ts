/**
 * POST /internal/hermes-callback — 容器异步回调（心跳 + 结果）。
 *
 * 鉴权: Bearer JWT (容器的 LAIFU_USER_TOKEN)，复用 containerToken middleware。
 * 不挂 session 鉴权中间件（来源是容器，不是浏览器）。
 *
 * Payload 是 discriminated union:
 *   { type: 'heartbeat', loop_id } — 容器还活着，刷新超时计时
 *   { type: 'result', loop_id, reply, exit_code, ... } — 最终结果
 */
import { Router, type Request, type Response, type Router as RouterType, type RequestHandler } from 'express';
import type { HermesCallbackPayload, HermesCallbackResult } from '@lingxi/shared';
import { genId } from '@lingxi/db';
import { dao } from '../db/index.js';
import { touchHeartbeat, consumePendingLoop, emitLoopEvent } from '../lib/pending-loops.js';
import { keepContainerWarm } from '../lib/container-warm-cache.js';
import { log } from '../lib/logger.js';

export interface CallbackRouterDeps {
  containerAuth: RequestHandler;
  /** 微信回复能力：给定 threadId 和回复文本，发送到对应微信对话 */
  wechatReplier?: (threadId: string, text: string) => Promise<void>;
}

export const buildCallbackRouter = (deps: CallbackRouterDeps): RouterType => {
  const r = Router();

  r.post('/internal/hermes-callback', deps.containerAuth, async (req: Request, res: Response) => {
    const userId = req.user_id!;
    const body = req.body as Partial<HermesCallbackPayload>;

    if (!body.loop_id) {
      return res.status(400).json({ error: 'loop_id required' });
    }
    if (!body.type) {
      return res.status(400).json({ error: 'type required' });
    }

    // ─── 心跳 ───
    // 容器还活着 → 仅 reset 内存 deadline timer。
    // 故意不写 DB: 旧代码会更新 iterated_at,但现在 iterated_at 被复用为 "result 已落库" 的 latch,
    // 一旦心跳写它就会污染 result callback 的幂等判断。心跳完全交给 per-loop timer 跟。
    if (body.type === 'heartbeat') {
      touchHeartbeat(body.loop_id);
      emitLoopEvent(body.loop_id, { type: 'heartbeat' });
      // 保活: 回敲容器 /health 产生一次入站流量, 重置 ACA scale-to-zero 冷却 (cooldown 300s >
      // 心跳 120s)。否则长任务 (vision) 后台跑超 300s 时副本会被 KEDA SIGTERM, agent 半路夭折。
      // fire-and-forget, 不阻塞心跳 ack。容器侧零改动。url 取内存缓存 (零 DB 查询)。
      const mapping = dao.cache.get(userId);
      if (mapping?.status === 'ready' && mapping.container_url) {
        keepContainerWarm(userId, mapping.container_url);
      }
      return res.json({ ok: true });
    }

    // ─── 最终结果 ───
    const result = body as Partial<HermesCallbackResult>;

    // 优先从内存取上下文（零查询），fallback 查 DB
    let threadId: string;
    let source: 'web' | 'wechat' | 'feishu';
    const cached = consumePendingLoop(body.loop_id);

    if (cached) {
      // 验证 JWT user_id 匹配
      if (cached.userId !== userId) {
        return res.status(403).json({ error: 'user mismatch' });
      }
      threadId = cached.threadId;
      source = cached.source;
    } else {
      // 进程重启了，fallback 到 DB
      const loop = await dao.agentLoops.getById(body.loop_id);
      if (!loop) {
        return res.status(404).json({ error: 'loop not found' });
      }
      const thread = await dao.threads.getByIdAndUser(loop.thread_id, userId);
      if (!thread) {
        return res.status(403).json({ error: 'thread ownership mismatch' });
      }
      threadId = loop.thread_id;
      source = thread.source as 'web' | 'wechat' | 'feishu';
    }

    // 确定 completion
    const completion = (result.exit_code === 0 && result.reply) ? 'success' : 'fail';

    // 幂等 latch: 抢 iterated_at IS NULL。
    // 即便 deadline timer 已先把 completion 标 fail (completed_at 已写但 iterated_at 未动),
    // result callback 在这里仍会赢并反转 completion → 不丢回复。
    // 重复 callback (容器重试 / 进程 redeliver) 第二次 0 rows → already_committed 直接返回。
    const won = await dao.agentLoops.recordResult(body.loop_id, completion);
    if (!won) {
      return res.json({ ok: true, already_committed: true });
    }

    // 插入 assistant 消息
    if (result.reply) {
      await dao.messages.insert({
        id: genId.message,
        thread_id: threadId,
        role: 'assistant',
        content_type: 'text',
        content: result.reply,
        source,
      });
    }

    // 计量
    if (result.usage) {
      dao.usage.recordUsage({
        userId,
        threadId,
        source,
        usage: result.usage,
      }).catch((err) => {
        log.warn({
          event: 'callback.usage.record.failed',
          user_id: userId,
          loop_id: body.loop_id,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }

    // 推送 per-loop SSE 事件到前端
    if (completion === 'success') {
      emitLoopEvent(body.loop_id, { type: 'done', reply: result.reply ?? '', completion: 'success' });
    } else {
      emitLoopEvent(body.loop_id, { type: 'fail', error: result.reply || 'agent 执行失败' });
    }


    // 微信回复
    if (source === 'wechat' && result.reply && deps.wechatReplier) {
      deps.wechatReplier(threadId, result.reply).catch((err) => {
        log.warn({
          event: 'callback.wechat.reply.failed',
          thread_id: threadId,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }

    log.info({
      event: 'hermes.callback.result',
      loop_id: body.loop_id,
      thread_id: threadId,
      user_id: userId,
      completion,
      reply_chars: result.reply?.length ?? 0,
    });

    res.json({ ok: true });
  });

  return r;
};
