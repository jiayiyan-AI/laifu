/**
 * 微信扫码绑定路由 (Phase 1.4 B 重写,iLink 个人号路径)。
 */
import { Router, type Request, type Response, type Router as RouterType, type RequestHandler } from 'express';
import { getBotQrcode, pollQrcodeStatus } from '../wechat-ilink/client.js';
import type { PollManager } from '../wechat-ilink/poll-manager.js';
import { dao } from '../db/index.js';

export interface WechatBindRouterOpts {
  pollMgr: PollManager;
  sessionMw: RequestHandler;
}

export const buildWechatBindRouter = (opts: WechatBindRouterOpts): RouterType => {
  const r = Router();
  const { pollMgr, sessionMw } = opts;

  r.post('/api/wechat/bind/qr-start', sessionMw, async (_req: Request, res: Response) => {
    try {
      const result = await getBotQrcode();
      res.json(result);
    } catch (e) {
      console.error('[wechat-bind] qr-start failed:', e);
      res.status(502).json({ error: 'iLink qrcode failed' });
    }
  });

  r.post('/api/wechat/bind/qr-poll', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const { qrcode } = (req.body ?? {}) as { qrcode?: string };
    if (!qrcode || typeof qrcode !== 'string') {
      return res.status(400).json({ error: 'qrcode required' });
    }

    const result = await pollQrcodeStatus(qrcode);

    if (result.status !== 'confirmed') {
      return res.json(result);
    }

    let binding;
    try {
      binding = await dao.wechatBindings.upsertByUserId({
        user_id: userId,
        ilink_bot_id: result.ilink_bot_id,
        bot_token: result.bot_token,
        base_url: result.base_url,
      });
    } catch (e) {
      console.error('[wechat-bind] upsert failed:', e);
      return res.status(500).json({ error: 'binding persist failed' });
    }

    pollMgr.startOne(binding);

    res.json({
      status: 'confirmed',
      bound: true,
      ilink_bot_id: binding.ilink_bot_id,
    });
  });

  r.get('/api/wechat/bind', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const binding = await dao.wechatBindings.getByUserId(userId);
    if (!binding || !binding.is_active) {
      return res.json({ bound: false });
    }
    res.json({
      bound: true,
      ilink_bot_id: binding.ilink_bot_id,
      bound_at: binding.bound_at,
    });
  });

  r.delete('/api/wechat/bind', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const binding = await dao.wechatBindings.getByUserId(userId);
    if (binding && binding.is_active) {
      pollMgr.stopOne(binding.id);
      try {
        await dao.wechatBindings.deactivate(binding.id);
      } catch (e) {
        console.error('[wechat-bind] deactivate failed:', e);
      }
    }
    res.json({ ok: true });
  });

  return r;
};
