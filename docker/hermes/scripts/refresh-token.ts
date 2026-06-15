// LAIFU_USER_TOKEN 续签: 解 JWT exp, 距过期 <7d 时调 /api/auth/refresh-token。
// 失败不致命: 留旧 token 继续走 (entitlement sync 失败时还有兜底)。
import { log, warn, readToken, writeToken, decodeJwtPayload, httpJson } from './lib.ts';

export async function runRefreshToken(): Promise<void> {
  const GATEWAY = process.env['GATEWAY_BASE_URL'];
  const token = readToken();
  if (!token) {
    warn('no LAIFU_USER_TOKEN in env or token file — skip refresh');
    return;
  }

  let exp = 0;
  try {
    exp = (decodeJwtPayload(token).exp as number | undefined) ?? 0;
  } catch (e) {
    warn(`failed to decode token: ${(e as Error).message}`);
    return;
  }
  const secsLeft = exp - Math.floor(Date.now() / 1000);
  log(`LAIFU_USER_TOKEN expires in ${Math.floor(secsLeft / 86400)} days`);

  if (secsLeft >= 7 * 86400) return;

  log('token within 7d of exp — refreshing');
  try {
    const { status, body } = await httpJson({
      method: 'POST',
      url: `${GATEWAY}/api/auth/refresh-token`,
      headers: { Authorization: `Bearer ${token}` },
      body: '',
      timeoutMs: 10_000,
    });
    if (status >= 200 && status < 300) {
      const parsed = JSON.parse(body) as { token?: string };
      if (parsed.token) {
        writeToken(parsed.token);
        log('token refreshed (new exp ~90 days)');
      } else {
        warn('refresh-token returned no token, keeping old');
      }
    } else {
      warn(`refresh-token HTTP ${status}: ${body.slice(0, 200)} — keeping old`);
    }
  } catch (e) {
    warn(`refresh-token request failed: ${(e as Error).message} — keeping old`);
  }
}
