/**
 * GET /api/me/usage — 用户端查本月用量 / 余额 / 免费额度
 *
 * 走 web session 鉴权 (跟 /api/status / /api/chat 一致)。
 * 只读 user_balance 一行, 前端可以按需刷新。
 */
import { Router, type Request, type Response, type Router as RouterType, type RequestHandler } from 'express';
import type { UsageDao } from '../db/usage-dao.js';

export interface MeUsageResponse {
  used_cny_month: number;
  free_quota_cny_month: number;
  balance_cny: number;
  period_start: string; // YYYY-MM-DD
}

export const buildMeUsageRouter = (
  usageDao: UsageDao,
  sessionMw: RequestHandler,
): RouterType => {
  const router = Router();

  router.get('/api/me/usage', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    try {
      const b = await usageDao.getBalance(userId);
      const body: MeUsageResponse = {
        used_cny_month: b.used_cny_month,
        free_quota_cny_month: b.free_quota_cny_month,
        balance_cny: b.balance_cny,
        period_start: b.period_start,
      };
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: 'internal', message: String(err) });
    }
  });

  return router;
};
