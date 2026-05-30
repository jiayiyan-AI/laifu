import express, { type Request, type Response, type Router as RouterType } from 'express';
import { Router } from 'express';

const PORT = parseInt(process.env['STUB_PORT'] ?? '8080', 10);

const streams = new Map<string, { message: string; sessionId: string }>();

const app = express();
app.use(express.json());

const r: RouterType = Router();

r.get('/healthz', (_req: Request, res: Response) => {
  res.json({ ok: true, stub: true });
});

r.post('/api/chat/start', (req: Request, res: Response) => {
  const { session_id, message } = req.body as { session_id?: string; message?: string };
  if (!session_id || !message) {
    return res.status(400).json({ error: 'session_id and message required' });
  }
  const streamId = `stub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  streams.set(streamId, { message, sessionId: session_id });
  res.json({ stream_id: streamId });
});

r.get('/api/chat/stream', async (req: Request, res: Response) => {
  const streamId = (req.query['stream_id'] as string | undefined) ?? '';
  const entry = streams.get(streamId);
  if (!entry) return res.status(404).json({ error: 'stream not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const write = (event: string, data: object) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const fakeReply = `收到「${entry.message}」。我是 stub container，正在被本地测试。`;
  const chars = [...fakeReply];
  const toolAt = Math.floor(chars.length / 2);

  for (let i = 0; i < chars.length; i++) {
    if (i === toolAt) write('tool', { name: 'search', preview: '查询天气...' });
    write('token', { text: chars[i] });
    await new Promise((r) => setTimeout(r, 80));
  }

  write('done', { full_reply: fakeReply, session_id: entry.sessionId });
  res.end();
  streams.delete(streamId);
});

app.use(r);

app.listen(PORT, () => {
  console.log(`[stub-container] listening on :${PORT}`);
});
