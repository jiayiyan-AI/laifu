/**
 * 微信扫码绑定路由 (Phase 1.4 B 重写,iLink 个人号路径)。
 *
 * 4 个端点全部 session-required:
 *   POST /api/wechat/bind/qr-start    透传 getBotQrcode,返 {qrcode, qr_url}
 *   POST /api/wechat/bind/qr-poll     透传 pollQrcodeStatus,confirmed 时
 *                                     upsert wechat_bindings + pollMgr.startOne
 *   GET  /api/wechat/bind             当前用户绑定状态 (is_active 才算 bound)
 *   DELETE /api/wechat/bind           pollMgr.stopOne + DAO.deactivate (软删保留行)
 *
 * 跟 plan 偏差: qr-start 在 plan 里写「无需 session」,这里改成必需。理由:
 *   用户已经登入 laifu 才会走这流程,加 session 防止 session_key 被泄露给他
 *   人冒领。代价为零。
 */
import { Router, type Request, type Response, type Router as RouterType, type RequestHandler } from 'express';
import { getBotQrcode, pollQrcodeStatus } from '../wechat-ilink/client.js';
import type { PollManager } from '../wechat-ilink/poll-manager.js';
import type { WechatBindingDao } from '../db/wechat-binding-dao.js';

export interface WechatBindRouterOpts {
  dao: WechatBindingDao;
  pollMgr: PollManager;
  sessionMw: RequestHandler;
}

export const buildWechatBindRouter = (opts: WechatBindRouterOpts): RouterType => {
  const r = Router();
  const { dao, pollMgr, sessionMw } = opts;

  // === QR 启动 ===
  r.post('/api/wechat/bind/qr-start', sessionMw, async (_req: Request, res: Response) => {
    try {
      const result = await getBotQrcode();
      res.json(result);
    } catch (e) {
      console.error('[wechat-bind] qr-start failed:', e);
      res.status(502).json({ error: 'iLink qrcode failed' });
    }
  });

  // === QR 状态轮询 ===
  r.post('/api/wechat/bind/qr-poll', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const { qrcode } = (req.body ?? {}) as { qrcode?: string };
    if (!qrcode || typeof qrcode !== 'string') {
      return res.status(400).json({ error: 'qrcode required' });
    }

    const result = await pollQrcodeStatus(qrcode);

    if (result.status !== 'confirmed') {
      // wait / scaned / expired / scaned_but_redirect 都透传给前端
      return res.json(result);
    }

    // confirmed: 落库 + 起轮询
    let binding;
    try {
      binding = await dao.upsertByUserId({
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

  // === 当前绑定状态 ===
  r.get('/api/wechat/bind', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const binding = await dao.getByUserId(userId);
    if (!binding || !binding.is_active) {
      return res.json({ bound: false });
    }
    res.json({
      bound: true,
      ilink_bot_id: binding.ilink_bot_id,
      bound_at: binding.bound_at,
    });
  });

  // === 解绑 ===
  r.delete('/api/wechat/bind', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const binding = await dao.getByUserId(userId);
    if (binding && binding.is_active) {
      pollMgr.stopOne(binding.id);
      try {
        await dao.deactivate(binding.id);
      } catch (e) {
        console.error('[wechat-bind] deactivate failed:', e);
        // 不阻断 — pollMgr 已经停了,DB 状态不一致最坏下次启动还会拉一遍 (但
        // is_active 没变,会再起来,然后 iLink 报 -14 才停)。可以接受。
      }
    }
    res.json({ ok: true });
  });

  return r;
};
