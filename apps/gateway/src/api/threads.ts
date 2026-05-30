import { Router, type Request, type Response, type Router as RouterType, type RequestHandler } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Thread } from '@lingxi/shared';

const newThreadId = (): string => {
  return `thr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
};

export const buildThreadsRouter = (
  sb: SupabaseClient,
  sessionMw: RequestHandler,
): RouterType => {
  const r = Router();

  r.post('/api/threads', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const { title } = (req.body ?? {}) as { title?: string };
    const id = newThreadId();
    const row: Partial<Thread> = {
      id,
      user_id: userId,
      source: 'web',
      title: title ?? null,
      archived: false,
    };
    const { error } = await sb.from('threads').insert(row);
    if (error) return res.status(500).json({ error: error.message });
    const { data } = await sb.from('threads').select('*').eq('id', id).single();
    res.json(data);
  });

  r.get('/api/threads', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const { data, error } = await sb
      .from('threads')
      .select('id, title, updated_at, archived')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ threads: data ?? [] });
  });

  r.get('/api/threads/:id', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const threadId = req.params['id'] as string;
    const { data, error } = await sb
      .from('threads')
      .select('*')
      .eq('id', threadId)
      .eq('user_id', userId)
      .single();
    if (error || !data) return res.status(404).json({ error: 'not found' });
    res.json(data);
  });

  r.delete('/api/threads/:id', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const threadId = req.params['id'] as string;
    const { error } = await sb
      .from('threads')
      .update({ archived: true })
      .eq('id', threadId)
      .eq('user_id', userId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  });

  return r;
};
