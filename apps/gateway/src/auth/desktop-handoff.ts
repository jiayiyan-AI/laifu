/**
 * 桌面 app「系统浏览器走 OAuth」的一次性交接码存储。
 *
 * 背景：Google 禁止在内嵌 WebView 里走 OAuth 授权（会报 "This browser or app may not
 * be secure"）。桌面 `home` 窗口的 OAuth 链接改由系统默认浏览器打开；浏览器和 app 的
 * WebView 是两个独立的 cookie jar，浏览器种下的 httpOnly session cookie 传不回 app。
 *
 * 用一次性码把「系统浏览器里刚登录成功的身份」带回 app 进程：
 *   1. OAuth callback 识别出这是桌面发起的 → mint 一个 code → 302 到
 *      `<desktopCallbackScheme>?code=<code>`，OS 把这个 URL 交给桌面 app（deep link）。
 *   2. app 用 code 换设备 JWT（`POST /api/auth/device-token/exchange`）。
 *   3. app 再用刚拿到的 JWT 换第二个 code（`POST /api/auth/session-code`），导航桌面
 *      `home` 窗口的内嵌 WebView 到 `GET /api/auth/session-from-code?code=<code2>`，
 *      让 gateway 在这次真实的 WebView 内导航响应里种 httpOnly session cookie。
 *
 * 单进程内存存储：code 只活 60 秒、用后即焚，足以覆盖"浏览器 302 → app 收到 deep link"
 * 这一瞬间的往返；不需要跨进程持久化（gateway 重启，飞行中的登录本就该重来）。
 */
import { randomBytes } from 'node:crypto';

const CODE_TTL_MS = 60 * 1000;

interface HandoffEntry {
  userId: string;
  expiresAt: number;
}

const codes = new Map<string, HandoffEntry>();

/** 生成 32 字节随机码（64 hex 字符），绑定 userId，60 秒后过期。 */
export const mintHandoffCode = (userId: string): string => {
  const code = randomBytes(32).toString('hex');
  codes.set(code, { userId, expiresAt: Date.now() + CODE_TTL_MS });
  return code;
};

/** 兑换：命中且未过期返回 userId 并即刻失效（一次性）；否则返回 null。 */
export const redeemHandoffCode = (code: string): string | null => {
  const entry = codes.get(code);
  codes.delete(code); // 无论成败都失效, 防重放
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.userId;
};
