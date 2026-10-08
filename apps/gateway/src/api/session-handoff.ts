/**
 * 桌面 app「系统浏览器走 OAuth」的第二跳：把设备 JWT 换回 `home` 窗口内嵌 WebView 的
 * httpOnly session cookie。背景与整体流程见 `auth/desktop-handoff.ts` 顶部注释。
 *
 *   POST /api/auth/session-code        Bearer 设备 JWT → 一次性码（60s，用后即焚）
 *   GET  /api/auth/session-from-code   一次性码 → 种 session cookie → 302 /desktop
 *
 * 第二个端点是一次真实的 WebView 内导航（不是 XHR/fetch），`Set-Cookie` 才能落进
 * 发起导航的那个 WebView 自己的 cookie 存储——这跟现有登录 webview 反向读 cookie
 * 是同一枚硬币的两面。
 */
import { Router, type Request, type Response, type Router as RouterType } from 'express';
import {
  verifyLaifuUserToken,
  TokenExpiredError,
  TokenInvalidError,
  TokenVersionMismatchError,
} from '../lib/gateway-token.js';
import { issueSessionCookie, sessionVersions } from '../auth/session-version.js';
import { mintHandoffCode, redeemHandoffCode } from '../auth/desktop-handoff.js';
import { dao } from '../db/index.js';
import type { SessionCodeResponse } from '@lingxi/shared';

export interface SessionHandoffDeps {
  /** config.auth.gatewaySecret —— 验桌面设备 JWT（session-code 端点）。 */
  deviceTokenSecret: string;
  /** config.session.secret —— 签 web session cookie（session-from-code 端点）。 */
  sessionSecret: string;
  cookieName: string;
  ttlHours: number;
  frontendBaseUrl: string;
}

export const buildSessionHandoffRouter = (deps: SessionHandoffDeps): RouterType => {
  const router = Router();

  router.post('/api/auth/session-code', async (req: Request, res: Response) => {
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) {
      res.status(401).json({ error: 'missing or non-Bearer Authorization header' });
      return;
    }
    const token = header.slice(7);

    let userId: string;
    try {
      // 只信 header 里明文声称的 user_id 来查 token_version；真正的签名/吊销校验在下面
      // verifyLaifuUserToken 里做（跟 container-token.ts 的 peekJwtPayload 手法一致）。
      const payloadJson = Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8');
      userId = JSON.parse(payloadJson).user_id;
      if (typeof userId !== 'string' || !userId) throw new Error('missing user_id');
    } catch {
      res.status(401).json({ error: 'invalid token' });
      return;
    }

    let currentVersion: number | null;
    try {
      currentVersion = await dao.entitlements.getTokenVersion(userId);
    } catch (err) {
      console.error(`[session-handoff] getTokenVersion threw for ${userId}:`, err);
      res.status(500).json({ error: 'internal' });
      return;
    }
    if (currentVersion === null) {
      res.status(401).json({ error: 'unknown user' });
      return;
    }

    let payload: ReturnType<typeof verifyLaifuUserToken>;
    try {
      payload = verifyLaifuUserToken(token, { expectedTokenVersion: currentVersion, secret: deps.deviceTokenSecret });
    } catch (err) {
      if (err instanceof TokenVersionMismatchError) {
        res.status(401).json({ error: 'token revoked (version mismatch)' });
        return;
      }
      if (err instanceof TokenExpiredError) {
        res.status(401).json({ error: 'token expired' });
        return;
      }
      if (err instanceof TokenInvalidError) {
        res.status(401).json({ error: 'invalid token' });
        return;
      }
      res.status(500).json({ error: 'internal' });
      return;
    }

    // 设备 token 的 sv 必须等于库里当前的 session_version, 否则说明签发它之后改过密码,
    // 不能再用它换出一张新的网页 session (否则被盗 cookie 可经设备 token 洗白, 绕过吊销)。
    // 无 sv 的老设备 token 视为 sv=0, 没改过密码的存量用户不受影响。
    // 代价 (有意接受): 任何一次改密码后, 持有旧设备 token 的桌面 app 都必须重新登录才能
    // 打开 home 窗口——这正是"其他设备已退出登录"。桌面同步盘 (云盘 SAS) 走 token_version, 不受影响。
    // 这里签发 session, 查询失败一律 fail-closed (500), 与 requireSession 的 fail-open 相反。
    let currentSv: number | null;
    try {
      currentSv = await sessionVersions.get(payload.userId);
    } catch (err) {
      console.error(`[session-handoff] session_version 查询失败 user=${payload.userId}:`, err);
      res.status(500).json({ error: 'internal' });
      return;
    }
    if (currentSv === null || (payload.sessionVersion ?? 0) !== currentSv) {
      console.warn(`[session-handoff] auth.session.revoked user=${payload.userId} sv=${payload.sessionVersion ?? 0} current=${currentSv}`);
      res.status(401).json({ error: 'session revoked' });
      return;
    }

    try {
      const body: SessionCodeResponse = { code: mintHandoffCode(payload.userId) };
      res.json(body);
    } catch (err) {
      console.error('[session-handoff] mint code failed:', err);
      res.status(500).json({ error: 'internal' });
    }
  });

  router.get('/api/auth/session-from-code', async (req: Request, res: Response) => {
    const code = typeof req.query['code'] === 'string' ? req.query['code'] : '';
    const userId = code ? redeemHandoffCode(code) : null;
    if (!userId) {
      res.status(401).json({ error: 'invalid or expired code' });
      return;
    }
    try {
      await issueSessionCookie(res, userId, { sessionSecret: deps.sessionSecret, cookieName: deps.cookieName, ttlHours: deps.ttlHours });
    } catch (e) {
      console.error('[session-handoff] issue session failed:', e);
      res.status(500).json({ error: 'internal' });
      return;
    }
    res.redirect(`${deps.frontendBaseUrl}/desktop`);
  });

  return router;
};
