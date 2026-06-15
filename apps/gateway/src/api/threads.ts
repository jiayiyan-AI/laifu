import { Router, type Request, type Response, type Router as RouterType, type RequestHandler } from 'express';
import { genId } from '@lingxi/db';
import { dao } from '../db/index.js';
import { deleteHermesSession } from '../lib/aca-call.js';
import { log } from '../lib/logger.js';

export const buildThreadsRouter = (
  sessionMw: RequestHandler,
  fetchImpl?: typeof fetch,
): RouterType => {
  const r = Router();

  r.post('/api/threads', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const { title } = (req.body ?? {}) as { title?: string };
    const id = genId.thread;
    try {
      const thread = await dao.threads.create({ id, user_id: userId, source: 'web', title: title ?? null });
      res.json(thread);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'insert failed' });
    }
  });

  r.get('/api/threads', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    try {
      const threads = await dao.threads.listByUser(userId);
      res.json({ threads });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'query failed' });
    }
  });

  r.get('/api/threads/:id', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const threadId = req.params['id'] as string;
    const thread = await dao.threads.getByIdAndUser(threadId, userId);
    if (!thread) return res.status(404).json({ error: 'not found' });
    res.json(thread);
  });

  // 硬删 thread + 容器侧 hermes session 清理。
  //
  // 顺序: 先打容器 `DELETE /session` (best-effort, 失败只 log warn), 再删 DB。
  // 容器先做的理由: DB 一旦删了, 这条记录的 source/thread_id 就没了, 我们就再没办法
  // 反查容器去清。容器侧出错的损失是 hermes state.db 多一条死 session (~KB), 用户
  // 看不见; DB 删失败用户看到「删不掉」, 损失更直观, 所以让 DB 删兜底成功。
  //
  // 跳过容器调用的两种情况:
  //  - 容器尚未 provision (mapping 不在 cache) — 那压根没 hermes session
  //  - mapping.status !== 'ready' 或没 container_url — 容器还在建/失败, 跟上面同理
  r.delete('/api/threads/:id', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const threadId = req.params['id'] as string;

    const thread = await dao.threads.getByIdAndUser(threadId, userId);
    if (!thread) return res.status(404).json({ error: 'not found' });

    const mapping = dao.cache.get(userId);
    if (mapping?.status === 'ready' && mapping.container_url) {
      const sessionId = `${thread.source}:${thread.id}`;
      const result = await deleteHermesSession({
        containerUrl: mapping.container_url,
        userId,
        threadId,
        source: thread.source,
        sessionId,
        fetchImpl,
      });
      if (!result.ok) {
        // 不阻断: 让 DB 删继续, 容器侧残留交后台兜底 / 下次 thread 重建时自然覆盖。
        // 这里要的是 warn 级别 — 用户层面看到的仍是删成功, ops 通过日志发现孤儿。
        log.warn({
          event: 'thread.delete.container_failed',
          user_id: userId,
          thread_id: threadId,
          status: result.status,
          err: result.error,
        });
      }
    }

    try {
      const removed = await dao.threads.deleteById(threadId, userId);
      if (!removed) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'delete failed' });
    }
  });

  return r;
};
