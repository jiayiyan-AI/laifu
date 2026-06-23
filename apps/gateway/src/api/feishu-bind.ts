/**
 * 飞书渠道绑定路由 (Task 12)。
 *
 * 流程: 用户网页点绑定 → scan-start 扫码建自建飞书 app (pending_approval)
 *      → 企业管理员后台审批 → 用户点"我已审批" (activate)
 *      → 探针验活 + 起 WS + 建 thread → active。
 *
 * 结构对标 wechat-bind.ts (buildWechatBindRouter):
 *   - 全端点过 sessionMw (requireSession), 从 req.session.user_id 拿 userId
 *   - async handler 全包 try/catch (进程不能因未捕获 reject 崩)
 *
 * scan-poll 用单次轮询 (registration.pollAppRegistrationOnce, 方案 A):
 *   前端反复调本端点, 每次立即返回 pending/approved/denied/expired,
 *   符合 web 长轮询语义 (对标微信 qr-poll)。
 */
import { Router, type Request, type Response, type Router as RouterType, type RequestHandler } from 'express';
import { genId } from '@lingxi/db';
import {
  beginAppRegistration,
  pollAppRegistrationOnce,
  getAppOwnerOpenId,
  type FeishuDomain,
} from '../feishu/registration.js';
import { probeFeishu } from '../feishu/probe.js';
import type { FeishuConnectionManager } from '../feishu/connection-manager.js';
import { dao } from '../db/index.js';

export interface FeishuBindRouterOpts {
  feishuMgr: FeishuConnectionManager;
  sessionMw: RequestHandler;
}

/**
 * 模块级 deviceCode → domain 记忆。
 *
 * scan-start 用 'feishu' 域 begin, 把 deviceCode→domain 存这；
 * scan-poll 按 deviceCode 取回当时 begin 用的 domain;
 * 若 poll 内部检测到 lark 域切换 (domainSwitchedTo), 更新该 Map,
 * 下次 poll 直接打到 lark 域。
 *
 * 进程内 Map 无 TTL — device code 本身有 expireIn 过期, 这里不主动清理,
 * 单进程下条目量极小 (并发绑定数), 不构成内存压力。
 */
const deviceDomains = new Map<string, FeishuDomain>();

/**
 * 飞书开放平台应用管理后台深链 (管理员审批入口)。
 * feishu 域 → open.feishu.cn; lark 域 → open.larksuite.com。
 * 尽力而为: 路径 /app/<appId>/baseinfo 为飞书自建应用详情页惯例,
 * 上游若改版可能失效, 但 appId 段始终带上, 管理员可手动定位。
 */
const adminConsoleUrl = (appId: string, domain: FeishuDomain): string => {
  const host = domain === 'lark' ? 'open.larksuite.com' : 'open.feishu.cn';
  return `https://${host}/app/${appId}/baseinfo`;
};

export const buildFeishuBindRouter = (opts: FeishuBindRouterOpts): RouterType => {
  const r = Router();
  const { feishuMgr, sessionMw } = opts;

  // 1. 扫码建 app: begin device-code flow, 存 deviceCode→domain。
  r.post('/api/feishu/bind/scan-start', sessionMw, async (_req: Request, res: Response) => {
    try {
      const result = await beginAppRegistration('feishu');
      deviceDomains.set(result.deviceCode, 'feishu');
      res.json({
        qrUrl: result.qrUrl,
        deviceCode: result.deviceCode,
        interval: result.interval,
        expireIn: result.expireIn,
      });
    } catch (e) {
      console.error('[feishu-bind] scan-start failed:', e);
      res.status(500).json({ error: 'feishu registration start failed' });
    }
  });

  // 2. 单次轮询: pending / approved(已建 app) / denied / expired。
  r.post('/api/feishu/bind/scan-poll', sessionMw, async (req: Request, res: Response) => {
    try {
      const userId = req.session!.user_id;
      const { deviceCode } = (req.body ?? {}) as { deviceCode?: string };
      if (!deviceCode || typeof deviceCode !== 'string') {
        return res.status(400).json({ error: 'deviceCode required' });
      }

      const domain = deviceDomains.get(deviceCode) ?? 'feishu';

      let outcome;
      try {
        outcome = await pollAppRegistrationOnce(deviceCode, domain);
      } catch (e) {
        // 网络抖动: 当作 pending, 让前端继续轮。
        console.warn('[feishu-bind] scan-poll transient error:', e);
        return res.json({ status: 'pending' });
      }

      // 域切换: 更新记忆, 本次回 pending, 下次直接打 lark。
      if (outcome.status === 'pending' && outcome.domainSwitchedTo) {
        deviceDomains.set(deviceCode, outcome.domainSwitchedTo);
        return res.json({ status: 'pending' });
      }

      if (outcome.status === 'pending') {
        return res.json({ status: 'pending' });
      }
      if (outcome.status === 'denied') {
        return res.json({ status: 'denied' });
      }
      if (outcome.status === 'expired') {
        return res.json({ status: 'expired' });
      }
      if (outcome.status === 'error') {
        // 内部错误: 回 pending 让前端继续轮, 真过期会单独命中 expired。
        console.warn('[feishu-bind] scan-poll registration error:', outcome.message);
        return res.json({ status: 'pending' });
      }

      // success: 解析 owner open_id → upsert 绑定 (pending_approval) → 返回深链。
      const creds = outcome.result;
      const ownerOpenId =
        (await getAppOwnerOpenId({
          appId: creds.appId,
          appSecret: creds.appSecret,
          domain: creds.domain,
        })) ?? creds.ownerOpenId ?? '';

      await dao.feishuBindings.upsertByUserId({
        userId,
        appId: creds.appId,
        appSecret: creds.appSecret,
        domain: creds.domain,
        ownerOpenId,
      });

      res.json({
        status: 'approved',
        appId: creds.appId,
        adminConsoleUrl: adminConsoleUrl(creds.appId, creds.domain),
      });
    } catch (e) {
      console.error('[feishu-bind] scan-poll failed:', e);
      res.status(500).json({ error: 'feishu scan-poll failed' });
    }
  });

  // 3. 我已审批: 探针验活 → 建 thread → 起 WS → active。
  r.post('/api/feishu/bind/activate', sessionMw, async (req: Request, res: Response) => {
    try {
      const userId = req.session!.user_id;
      const binding = await dao.feishuBindings.getByUserId(userId);
      if (!binding) {
        return res.status(400).json({ error: 'no feishu binding to activate' });
      }

      const probe = await probeFeishu({
        appId: binding.app_id,
        appSecret: binding.app_secret,
        domain: (binding.domain === 'lark' ? 'lark' : 'feishu') as FeishuDomain,
      });
      if (!probe.ok) {
        // 验活失败 = 多半审批没完成, 让前端提示用户回后台确认。
        return res.status(409).json({ error: probe.error ?? 'feishu probe failed (审批未完成?)' });
      }

      // 1 用户 1 thread: 建一条 source='feishu' 的 thread。
      const threadId = genId.thread;
      await dao.threads.create({ id: threadId, user_id: userId, source: 'feishu', title: '飞书' });
      await dao.feishuBindings.bindThread(binding.id, threadId);
      await dao.feishuBindings.setActive(binding.id, 'active');

      // 起 WS 长连接 (用带上 thread_id / active 的最新 binding 视图)。
      feishuMgr.startOne({ ...binding, thread_id: threadId, status: 'active' });

      res.json({ ok: true });
    } catch (e) {
      console.error('[feishu-bind] activate failed:', e);
      res.status(500).json({ error: 'feishu activate failed' });
    }
  });

  // 4. 解绑: 停 WS + 软删绑定。
  r.post('/api/feishu/bind/unbind', sessionMw, async (req: Request, res: Response) => {
    try {
      const userId = req.session!.user_id;
      const binding = await dao.feishuBindings.getByUserId(userId);
      if (binding) {
        feishuMgr.stopOne(binding.id);
        try {
          await dao.feishuBindings.deactivate(binding.id);
        } catch (e) {
          console.error('[feishu-bind] deactivate failed:', e);
        }
      }
      res.json({ ok: true });
    } catch (e) {
      console.error('[feishu-bind] unbind failed:', e);
      res.status(500).json({ error: 'feishu unbind failed' });
    }
  });

  // 5. 绑定状态查询。
  r.get('/api/feishu/bind', sessionMw, async (req: Request, res: Response) => {
    try {
      const userId = req.session!.user_id;
      const binding = await dao.feishuBindings.getByUserId(userId);
      if (!binding || !binding.is_active) {
        return res.json({ bound: false });
      }
      res.json({
        bound: true,
        status: binding.status,
        app_id: binding.app_id,
      });
    } catch (e) {
      console.error('[feishu-bind] get binding failed:', e);
      res.status(500).json({ error: 'feishu binding query failed' });
    }
  });

  return r;
};
