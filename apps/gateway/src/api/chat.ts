import { Router, type Request, type Response, type Router as RouterType, type RequestHandler } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ContainerMappingCache } from '../db/cache.js';
import type {
  ContainerChatResponse,
  ContainerHistoryResponse,
  WebChatResponse,
  WebThreadMessagesResponse,
} from '@lingxi/shared';

export const buildChatRouter = (
  sb: SupabaseClient,
  cache: ContainerMappingCache,
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

  return r;
};
