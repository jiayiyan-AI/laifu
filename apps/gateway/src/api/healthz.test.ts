import { Router, type Request, type Response } from 'express';

const startedAt = Date.now();

// Test: Try with explicit type
export const healthzRouter: ReturnType<typeof Router> = Router();

healthzRouter.get('/healthz', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
  });
});
