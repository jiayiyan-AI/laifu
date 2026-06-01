import { Router, type Request, type Response, type Router as RouterType, type RequestHandler } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ContainerMappingCache } from '../db/cache.js';
import type { ThreadStreamHub } from '../lib/thread-stream.js';
import type {
  ContainerChatResponse,
  ContainerHistoryResponse,
  WebChatResponse,
  WebThreadMessagesResponse,
} from '@lingxi/shared';

const SSE_HEARTBEAT_MS = 30_000;

export const buildChatRouter = (
  sb: SupabaseClient,
  cache: ContainerMappingCache,
  sessionMw: RequestHandler,
  hub?: ThreadStreamHub,             // 可选: 没传就不挂 SSE 端点 (测试方便)
): RouterType => {
  const r = Router();

  r.post('/api/chat', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const { thread_id, message } = (req.body ?? {}) as { thread_id?: string; message?: string };
    if (!thread_id || !message) {
      return res.status(400).json({ error: 'thread_id and message required' });
    }

    // 1. 验证 thread 属于该用户
    const { data: thread, error: thErr } = await sb
      .from('threads').select('*').eq('id', thread_id).eq('user_id', userId).single();
    if (thErr || !thread) return res.status(404).json({ error: 'thread not found' });

    // 2. 取该用户的 container url
    const mapping = cache.get(userId);
    if (!mapping || mapping.status !== 'ready' || !mapping.container_url) {
      return res.status(503).json({ error: 'assistant not ready' });
    }

    // 3. 调容器同步 /chat,等结果
    //    session_id 用 thread.source 拼前缀 (web:/wechat:),跟入站方 (inbound-handler)
    //    保持一致,否则 web 与 wechat 同 thread 在 hermes 里是两条独立对话。
    const threadSource = (thread as { source: string }).source;
    const sessionId = `${threadSource}:${thread_id}`;
    const cResp = await fetch(`${mapping.container_url}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, session_id: sessionId, source: threadSource }),
    });
    if (!cResp.ok) {
      return res.status(502).json({ error: `container returned ${cResp.status}` });
    }
    const cBody = await cResp.json() as ContainerChatResponse;
    if (typeof cBody.reply !== 'string') {
      return res.status(502).json({ error: 'container missing reply' });
    }

    // 通知其它订阅同 thread 的 SSE 客户端 (例如另一个标签页) 该 thread 有更新
    hub?.emit(thread_id, 'thread-updated', { thread_id });

    const body: WebChatResponse = { reply: cBody.reply };
    res.json(body);
  });

  // 读取 thread 历史消息 (从 Hermes SQLite 经容器 /history 端点取)
  // 路由放这里而非 threads.ts,因为依赖 cache + container 转发,跟 POST /api/chat 同形
  r.get('/api/threads/:id/messages', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const threadId = req.params['id'] as string;

    const { data: thread, error: thErr } = await sb
      .from('threads').select('*').eq('id', threadId).eq('user_id', userId).single();
    if (thErr || !thread) return res.status(404).json({ error: 'thread not found' });

    const mapping = cache.get(userId);
    if (!mapping || mapping.status !== 'ready' || !mapping.container_url) {
      return res.status(503).json({ error: 'assistant not ready' });
    }

    // session_id 跟写入侧拼一致 (POST /api/chat 和 inbound-handler 都用 source 前缀)
    const threadSource = (thread as { source: string }).source;
    const sessionId = `${threadSource}:${threadId}`;
    const url = `${mapping.container_url}/history?session_id=${encodeURIComponent(sessionId)}`;
    const cResp = await fetch(url);
    if (!cResp.ok) {
      return res.status(502).json({ error: `container returned ${cResp.status}` });
    }
    const cBody = await cResp.json() as ContainerHistoryResponse;
    const body: WebThreadMessagesResponse = { messages: cBody.messages ?? [] };
    res.json(body);
  });

  // SSE 通知: 新消息到 (微信入站 / web 发送 / 其它来源) 时通知前端 refetch
  // 帧形 event: thread-updated\ndata: {"thread_id":"..."}\n\n
  if (hub) {
    r.get('/api/threads/:id/stream', sessionMw, async (req: Request, res: Response) => {
      const userId = req.session!.user_id;
      const threadId = req.params['id'] as string;

      // 权限校验
      const { data: thread } = await sb
        .from('threads').select('id').eq('id', threadId).eq('user_id', userId).maybeSingle();
      if (!thread) return res.status(404).end();

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      // nginx/反代防缓冲
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      // 立即 flush 一帧让客户端确认连上
      res.write(': connected\n\n');

      const unsub = hub.subscribe(threadId, res);
      const heartbeat = setInterval(() => {
        try { res.write(': heartbeat\n\n'); } catch { /* socket dead, close 会兜底 */ }
      }, SSE_HEARTBEAT_MS);

      req.on('close', () => {
        clearInterval(heartbeat);
        unsub();
        res.end();
      });
    });
  }

  return r;
};
