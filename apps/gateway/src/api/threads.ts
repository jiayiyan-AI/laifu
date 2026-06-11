import { Router, type Request, type Response, type Router as RouterType, type RequestHandler } from 'express';
import type { ThreadsDao } from '../db/threads-dao.js';
import { genId } from '@lingxi/db';

export const buildThreadsRouter = (
  threadsDao: ThreadsDao,
  sessionMw: RequestHandler,
): RouterType => {
  const r = Router();

  r.post('/api/threads', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const { title } = (req.body ?? {}) as { title?: string };
    const id = genId.thread;
    try {
      const thread = await threadsDao.create({ id, user_id: userId, source: 'web', title: title ?? null });
      res.json(thread);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'insert failed' });
    }
  });

  r.get('/api/threads', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    try {
      const threads = await threadsDao.listByUser(userId);
      res.json({ threads });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'query failed' });
    }
  });

  r.get('/api/threads/:id', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const threadId = req.params['id'] as string;
    const thread = await threadsDao.getByIdAndUser(threadId, userId);
    if (!thread) return res.status(404).json({ error: 'not found' });
    res.json(thread);
  });

  r.delete('/api/threads/:id', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const threadId = req.params['id'] as string;
    try {
      await threadsDao.archive(threadId, userId);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'update failed' });
    }
  });

  return r;
};
