/**
 * 动态 OAuth 路由 —— 一个 router 接所有 provider。
 *
 *   GET /api/auth/:provider/start
 *     ↓ 跳到 provider 同意页 (state cookie 防 CSRF)
 *     （若 ?client=desktop 且该浏览器已持有有效 session cookie：跳过 Google，直接复用，
 *       见下方"已登录复用"分支——不强迫用户在已登录的浏览器里重新走一遍 OAuth。）
 *   GET /api/auth/:provider/callback
 *     ↓ 换 token → 取 userinfo → upsert users → 发 session cookie → 302 /desktop
 *     （若 start 时带 ?client=desktop：不发 cookie，302 到前端桥接页 `/desktop-oauth-complete`
 *       带一次性交接码 + `channel` 参数；该页 JS 据 `channel` 选对应 scheme 跳
 *       `laifu(-canary|-dev)?://auth-callback`。gateway 完全不需要知道桌面 app 的 URL
 *       scheme——scheme 是客户端常量，写死在前端里，不是运维配置项；gateway 只需要
 *       原样透传桌面发起时带来的 `channel` 值。
 *       见 auth/desktop-handoff.ts 顶部注释——系统浏览器和桌面 WebView 是两个 cookie jar，
 *       Google 又禁止在内嵌 WebView 里走 OAuth，只能靠这个一次性码把身份带回 app。）
 *
 * 加新 provider 只要在 providers/index.ts 注册一行,不动这里。
 */
import { Router, type Request, type Response, type Router as RouterType } from 'express';
import { randomBytes } from 'node:crypto';
import { signSession, verifySession, sessionCookieOpts } from './session.js';
import { mintHandoffCode } from './desktop-handoff.js';
import type { OAuthProvider, NormalizedUser } from './providers/types.js';
import { dao } from '../db/index.js';

const STATE_COOKIE = 'lingxi_oauth_state';
const DESKTOP_COOKIE = 'lingxi_oauth_desktop';
const STATE_TTL_MS = 10 * 60 * 1000;

/** 桌面渠道白名单，须与 `apps/desktop/src-tauri/src/channel.rs` 的 `Channel` 取值一致。 */
const DESKTOP_CHANNELS: Record<string, true> = { dev: true, canary: true, stable: true };

function normalizeDesktopChannel(raw: unknown): string {
  return typeof raw === 'string' && DESKTOP_CHANNELS[raw] ? raw : 'stable';
}

/**
 * OAuth callback 只接受本服务签发的渠道 cookie。保留旧版固定值 `1` 十分钟 TTL 内的
 * 回调兼容，统一让它回 stable；任意其它异常值仍按普通 web OAuth 发 session cookie。
 */
function desktopChannelFromCookie(raw: unknown): string | null {
  if (raw === '1') return 'stable';
  return typeof raw === 'string' && DESKTOP_CHANNELS[raw] ? raw : null;
}

export interface OAuthRouterOpts {
  providers: Record<string, OAuthProvider>;
  sessionSecret: string;
  cookieName: string;
  ttlHours: number;
  publicBaseUrl: string;
  frontendBaseUrl: string;
}

const redirectUriFor = (publicBaseUrl: string, provider: string): string =>
  `${publicBaseUrl}/api/auth/${provider}/callback`;

export const buildOAuthRouter = (opts: OAuthRouterOpts): RouterType => {
  const r = Router();

  r.get('/api/auth/:provider/start', (req: Request, res: Response) => {
    const providerName = req.params['provider']!;
    const provider = opts.providers[providerName];
    if (!provider) return res.status(404).json({ error: `unknown provider: ${providerName}` });

    // 桌面「系统浏览器走 OAuth」发起：若该浏览器已持有一份有效 session（比如用户之前在
    // 这个浏览器登过 web 版），直接复用——不逼用户在已登录的浏览器里重新过一遍 Google 授权。
    // 只做签名+shape校验（跟 requireSession 中间件同一信任级别，不查 token_version/revocation，
    // 与站内其它 session 消费点一致）。cookie 缺失/过期/被篡改都静默落回正常 OAuth 流程。
    if (req.query['client'] === 'desktop') {
      const channel = normalizeDesktopChannel(req.query['channel']);
      const existing = (req as Request & { cookies?: Record<string, string> }).cookies?.[opts.cookieName];
      if (existing) {
        try {
          const { user_id } = verifySession(existing, opts.sessionSecret);
          const handoffCode = mintHandoffCode(user_id);
          res.redirect(`${opts.frontendBaseUrl}/desktop-oauth-complete?code=${encodeURIComponent(handoffCode)}&channel=${channel}`);
          return;
        } catch {
          // 过期/篡改/坏格式：忽略，继续走下面的正常 OAuth 流程。
        }
      }
    }

    const state = randomBytes(16).toString('hex');
    res.cookie(STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: STATE_TTL_MS,
      path: '/',
    });
    // 桌面系统浏览器发起：记一个短命 cookie（值 = 渠道名），callback 据此走 deep link
    // 分支而非发 session cookie，并知道回跳哪个渠道的 scheme。
    if (req.query['client'] === 'desktop') {
      res.cookie(DESKTOP_COOKIE, normalizeDesktopChannel(req.query['channel']), {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: STATE_TTL_MS,
        path: '/',
      });
    }

    const redirectUri = redirectUriFor(opts.publicBaseUrl, providerName);
    res.redirect(provider.buildAuthUrl(state, redirectUri));
  });

  r.get('/api/auth/:provider/callback', async (req: Request, res: Response) => {
    const providerName = req.params['provider']!;
    const provider = opts.providers[providerName];
    if (!provider) return res.status(404).json({ error: `unknown provider: ${providerName}` });

    if (req.query['error']) {
      return res.status(400).json({
        error: 'oauth provider returned error',
        detail: String(req.query['error']),
      });
    }

    const code = req.query['code'] as string | undefined;
    const state = req.query['state'] as string | undefined;
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
    const cookieState = cookies?.[STATE_COOKIE];
    const desktopChannel = desktopChannelFromCookie(cookies?.[DESKTOP_COOKIE]);
    const isDesktop = desktopChannel !== null;
    if (!code || !state || !cookieState || state !== cookieState) {
      return res.status(400).json({ error: 'invalid state (CSRF)' });
    }
    res.clearCookie(STATE_COOKIE);
    if (isDesktop) res.clearCookie(DESKTOP_COOKIE);

    let accessToken: string;
    try {
      const result = await provider.exchangeCode(code, redirectUriFor(opts.publicBaseUrl, providerName));
      accessToken = result.access_token;
    } catch (e) {
      console.error(`[oauth-router] ${providerName} exchangeCode failed:`, e);
      return res.status(502).json({ error: 'oauth token exchange failed' });
    }

    let userinfo: NormalizedUser;
    try {
      userinfo = await provider.fetchUserinfo(accessToken);
    } catch (e) {
      console.error(`[oauth-router] ${providerName} fetchUserinfo failed:`, e);
      return res.status(502).json({ error: 'oauth userinfo fetch failed' });
    }

    const row = await dao.users.upsertByProvider(providerName, userinfo);
    if (!row) return res.status(500).json({ error: 'user upsert failed' });

    // 桌面系统浏览器发起：不发 session cookie（浏览器和桌面 WebView 是两个 cookie jar，
    // 发了也传不回 app）。改签一次性交接码，302 到前端桥接页；该页 JS 跳 `laifu://` deep
    // link，app 侧收到后用该码换设备 JWT（见 device-token.ts exchange 端点），再自己
    // 想办法把 home 窗口的 WebView 也种上 cookie。
    if (isDesktop) {
      const handoffCode = mintHandoffCode(row.id);
      res.redirect(`${opts.frontendBaseUrl}/desktop-oauth-complete?code=${encodeURIComponent(handoffCode)}&channel=${desktopChannel}`);
      return;
    }

    const token = signSession({ user_id: row.id }, opts.sessionSecret, opts.ttlHours);
    res.cookie(opts.cookieName, token, sessionCookieOpts(opts.ttlHours));
    res.redirect(`${opts.frontendBaseUrl}/desktop`);
  });

  return r;
};
