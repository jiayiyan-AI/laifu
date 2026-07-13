import { Router, type Router as RouterType, type Request, type Response, type RequestHandler } from 'express';
import { dao } from '../db/index.js';
import { signLaifuUserTokenWithExpiry } from '../lib/gateway-token.js';
import { redeemHandoffCode } from '../auth/desktop-handoff.js';
import type { DeviceTokenResponse } from '@lingxi/shared';

export interface DeviceTokenDeps {
  /** 复用 index.ts 已构建的 requireSession 中间件（验 session cookie）。 */
  sessionMw: RequestHandler;
  /** config.auth.gatewaySecret，签设备 JWT 用（与容器 JWT 同密钥）。 */
  secret: string;
}

/** 查 token_version 并签发设备 JWT；device-token 与 device-token/exchange 共用。 */
const issueDeviceToken = async (
  userId: string,
  secret: string,
): Promise<DeviceTokenResponse | null> => {
  const version = await dao.entitlements.getTokenVersion(userId);
  if (version === null) return null;
  const { token, expiresAt } = signLaifuUserTokenWithExpiry({ userId, tokenVersion: version, secret });
  return { token, expires_at: expiresAt };
};

/**
 * POST /api/auth/device-token
 *
 * 桌面同步盘客户端（继 web session、agent 容器 JWT 之后的第三种主体）用
 * session cookie 换取长效设备 JWT。签出的 JWT 与容器 JWT 同密钥、同 shape，
 * 因此 /api/cloud/sas 的 containerAuth 天然接受，无需改 cloud.ts。
 * 后续续期直接复用 POST /api/auth/refresh-token。
 *
 * POST /api/auth/device-token/exchange
 *
 * 桌面「系统浏览器走 OAuth」的第一跳：用 auth/desktop-handoff.ts 签发的一次性交接码
 * （由 deep link 带回 app）换设备 JWT，鉴权靠 code 本身（60 秒有效、用后即焚），
 * 不靠 session cookie——系统浏览器和桌面 WebView 是两个独立 cookie jar，浏览器种下
 * 的 cookie 传不回 app，见 desktop-handoff.ts 顶部注释。
 */
export const buildDeviceTokenRouter = (deps: DeviceTokenDeps): RouterType => {
  const router = Router();

  router.post('/api/auth/device-token', deps.sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    let body: DeviceTokenResponse | null;
    try {
      body = await issueDeviceToken(userId, deps.secret);
    } catch (err) {
      console.error(`[device-token] getTokenVersion threw for ${userId}:`, err);
      res.status(500).json({ error: 'internal' });
      return;
    }
    if (!body) {
      res.status(401).json({ error: 'unknown user' });
      return;
    }
    res.json(body);
  });

  router.post('/api/auth/device-token/exchange', async (req: Request, res: Response) => {
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    const userId = code ? redeemHandoffCode(code) : null;
    if (!userId) {
      res.status(401).json({ error: 'invalid or expired code' });
      return;
    }
    let body: DeviceTokenResponse | null;
    try {
      body = await issueDeviceToken(userId, deps.secret);
    } catch (err) {
      console.error(`[device-token] getTokenVersion threw for ${userId}:`, err);
      res.status(500).json({ error: 'internal' });
      return;
    }
    if (!body) {
      res.status(401).json({ error: 'unknown user' });
      return;
    }
    res.json(body);
  });

  return router;
};
