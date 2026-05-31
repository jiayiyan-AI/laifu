/**
 * 微信公众号扫码绑定 —— 6 个端点。
 *
 *   POST   /api/wechat/bind/start        生成带参 QR ticket(precondition: 容器 ready + 未绑)
 *   GET    /api/wechat/bind/status       前端轮询 token 绑了没
 *   GET    /api/wechat/bind              当前用户绑定状态(WechatApp mount 时拉)
 *   DELETE /api/wechat/bind              解绑(只清我们这边记录,不影响用户微信的关注关系)
 *   GET    /api/wechat/webhook           微信验签握手(配置 webhook URL 时打来)
 *   POST   /api/wechat/webhook           微信事件推送(SCAN/subscribe 触发实际绑定动作)
 *
 * webhook 必须返回 200 — 任何非 200 微信都会重试,会导致重复触发绑定逻辑。
 * 我们的绑定写入用 upsert,幂等。
 */
import { Router, type Request, type Response, type Router as RouterType, type RequestHandler } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import express from 'express';
import { randomBytes } from 'node:crypto';
import type { MpClient } from '../wechat/mp-client.js';
import { verifyWebhookSignature } from '../wechat/mp-client.js';
import { parseWechatEvent } from '../wechat/webhook-parser.js';

const SCENE_PREFIX = 'bind_';
const TICKET_TTL_SECONDS = 600;        // 10 分钟,跟 mp-client 默认 QR expire 对齐

export interface WechatBindRouterOpts {
  sb: SupabaseClient;
  mpClient: MpClient;
  mpToken: string;                     // webhook 共享 token,用于签名校验
  sessionMw: RequestHandler;
}

interface ContainerMappingRow { status: string }
interface WechatBindingRow { user_id: string; mp_openid: string }
interface WechatBindTicketRow { token: string; user_id: string; mp_openid: string | null; expires_at: string }

export const buildWechatBindRouter = (opts: WechatBindRouterOpts): RouterType => {
  const r = Router();
  const { sb, mpClient, mpToken, sessionMw } = opts;

  // === 当前绑定状态 ===
  r.get('/api/wechat/bind', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const { data } = await sb
      .from('wechat_bindings')
      .select('user_id, mp_openid')
      .eq('user_id', userId)
      .maybeSingle();
    if (data) {
      const row = data as WechatBindingRow;
      return res.json({ bound: true, mp_openid: row.mp_openid });
    }
    res.json({ bound: false });
  });

  // === 启动绑定 ===
  r.post('/api/wechat/bind/start', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;

    // precondition 1: 容器 ready
    const { data: mapping } = await sb
      .from('container_mapping')
      .select('status')
      .eq('user_id', userId)
      .maybeSingle();
    if (!mapping || (mapping as ContainerMappingRow).status !== 'ready') {
      return res.status(412).json({ error: 'container not ready' });
    }

    // precondition 2: 没绑过(避免重复绑定串号)
    const { data: existing } = await sb
      .from('wechat_bindings')
      .select('user_id')
      .eq('user_id', userId)
      .maybeSingle();
    if (existing) {
      return res.status(409).json({ error: 'already bound' });
    }

    // 生成 token + 调微信 qrcode/create
    const token = randomBytes(16).toString('hex');
    let qr: { ticket: string; url: string; expire_seconds: number };
    try {
      qr = await mpClient.createBindQrCode(SCENE_PREFIX + token, TICKET_TTL_SECONDS);
    } catch (e) {
      console.error('[wechat-bind] qrcode/create failed:', e);
      return res.status(502).json({ error: 'qrcode create failed' });
    }

    const expiresAt = new Date(Date.now() + qr.expire_seconds * 1000).toISOString();
    const { error } = await sb
      .from('wechat_bind_tickets')
      .insert({
        token,
        user_id: userId,
        ticket_url: qr.url,
        expires_at: expiresAt,
      });
    if (error) {
      console.error('[wechat-bind] insert ticket failed:', error);
      return res.status(500).json({ error: 'ticket insert failed' });
    }

    res.json({ qr_url: qr.url, token, expires_at: expiresAt });
  });

  // === 轮询绑定状态 ===
  r.get('/api/wechat/bind/status', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const token = req.query['token'];
    if (typeof token !== 'string' || token.length === 0) {
      return res.status(400).json({ error: 'token required' });
    }
    const { data } = await sb
      .from('wechat_bind_tickets')
      .select('token, user_id, mp_openid, expires_at')
      .eq('token', token)
      .eq('user_id', userId)
      .maybeSingle();
    if (!data) return res.status(404).json({ error: 'ticket not found' });
    const row = data as WechatBindTicketRow;
    if (row.mp_openid) return res.json({ bound: true, mp_openid: row.mp_openid });
    res.json({ bound: false });
  });

  // === 解绑 ===
  r.delete('/api/wechat/bind', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    await sb.from('wechat_bindings').delete().eq('user_id', userId);
    await sb.from('wechat_bind_tickets').delete().eq('user_id', userId);
    res.json({ ok: true });
  });

  // === Webhook 验签握手(微信配 URL 时立刻 GET) ===
  //
  // ⚠️ Content-Type 必须是 text/html (不是 text/plain,不是 application/json)。
  //    微信测试号 / 公众号侧会显式校验响应 Content-Type,即便 body 是正确的
  //    echostr,Content-Type 不是 text/html 也会被判定为"Token 验证失败"。
  //    Express res.send(string) 默认就发 text/html;charset=utf-8,直接 send 即可。
  r.get('/api/wechat/webhook', (req: Request, res: Response) => {
    const signature = String(req.query['signature'] ?? '');
    const timestamp = String(req.query['timestamp'] ?? '');
    const nonce = String(req.query['nonce'] ?? '');
    const echostr = String(req.query['echostr'] ?? '');
    if (!signature || !timestamp || !nonce || !echostr) {
      return res.status(400).send('bad params');
    }
    if (!verifyWebhookSignature(signature, timestamp, nonce, mpToken)) {
      return res.status(401).send('bad signature');
    }
    res.send(echostr);
  });

  // === Webhook 事件推送 ===
  // express.json 跳过 text/xml,所以 req.body 没值,这里挂一个 text 解析器把 XML body 拿到。
  r.post('/api/wechat/webhook', express.text({ type: '*/*' }), async (req: Request, res: Response) => {
    const signature = String(req.query['signature'] ?? '');
    const timestamp = String(req.query['timestamp'] ?? '');
    const nonce = String(req.query['nonce'] ?? '');
    if (!verifyWebhookSignature(signature, timestamp, nonce, mpToken)) {
      return res.status(401).send('');
    }

    const xml = typeof req.body === 'string' ? req.body : '';
    const evt = parseWechatEvent(xml);

    const sceneStr = evt.type === 'SCAN' ? evt.sceneStr
      : evt.type === 'subscribe' ? evt.sceneStr
      : undefined;

    if (sceneStr?.startsWith(SCENE_PREFIX) && (evt.type === 'SCAN' || evt.type === 'subscribe')) {
      const token = sceneStr.slice(SCENE_PREFIX.length);
      const { data: ticket } = await sb
        .from('wechat_bind_tickets')
        .select('user_id, expires_at')
        .eq('token', token)
        .maybeSingle();

      if (ticket) {
        const row = ticket as { user_id: string; expires_at: string };
        if (new Date(row.expires_at).getTime() > Date.now()) {
          const mpOpenid = evt.fromUser;
          // 落 wechat_bindings(upsert 幂等,微信偶尔会重推同一事件)
          await sb
            .from('wechat_bindings')
            .upsert({ user_id: row.user_id, mp_openid: mpOpenid }, { onConflict: 'user_id' });
          // 写到 ticket 让前端轮询能看到
          await sb
            .from('wechat_bind_tickets')
            .update({ mp_openid: mpOpenid })
            .eq('token', token);
        }
      }
    }

    // 微信要求所有事件回 200 success,否则会重试。
    // 同 GET 一样,Content-Type 必须是 text/html (Express res.send 默认即是)。
    res.send('success');
  });

  return r;
};
