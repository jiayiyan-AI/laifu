import { Router, type Request, type Response, type Router as RouterType, type RequestHandler } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ContainerMappingCache } from '../db/cache.js';
import type { StreamRegistry } from '../chat/stream-registry.js';

export const buildChatRouter = (
  sb: SupabaseClient,
  cache: ContainerMappingCache,
  registry: StreamRegistry,
  sessionMw: RequestHandler,
): RouterType => {
  const r = Router();

  r.post('/api/chat/start', sessionMw, async (req: Request, res: Response) => {
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

    // 3. 调 container 的 /api/chat/start
    const sessionId = `web:${thread_id}`;
    const cResp = await fetch(`${mapping.container_url}/api/chat/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, message, source: 'web' }),
    });
    if (!cResp.ok) {
      return res.status(502).json({ error: `container returned ${cResp.status}` });
    }
    const cBody = await cResp.json() as { stream_id?: string };
    if (!cBody.stream_id) {
      return res.status(502).json({ error: 'container missing stream_id' });
    }

    // 4. 注册映射，返回外层 stream_id
    const outer = registry.register({
      containerUrl: mapping.container_url,
      innerStreamId: cBody.stream_id,
    });
    res.json({ stream_id: outer });
  });

  r.get('/api/chat/stream', sessionMw, async (req: Request, res: Response) => {
    const outerSid = req.query['stream_id'] as string | undefined;
    if (!outerSid) return res.status(400).json({ error: 'stream_id required' });

    const entry = registry.resolve(outerSid);
    if (!entry) return res.status(404).json({ error: 'stream not found or expired' });

    const upstream = await fetch(
      `${entry.containerUrl}/api/chat/stream?stream_id=${encodeURIComponent(entry.innerStreamId)}`,
    );
    if (!upstream.ok || !upstream.body) {
      registry.release(outerSid);
      return res.status(502).json({ error: 'container stream failed' });
    }

    // 透传 SSE 字节流
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch (err) {
      console.error('[chat/stream] pipe error:', err);
    } finally {
      registry.release(outerSid);
      res.end();
    }
  });

  return r;
};
