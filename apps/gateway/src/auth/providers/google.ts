import type { OAuthProvider, NormalizedUser } from './types.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

interface GoogleConfig {
  clientId: string;
  clientSecret: string;
}

interface GoogleUserinfo {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
}

export const makeGoogleProvider = ({ clientId, clientSecret }: GoogleConfig): OAuthProvider => ({
  buildAuthUrl(state, redirectUri) {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      // 强制每次都让用户选账号 —— 便于测试用同一浏览器登多个 Google 账号
      prompt: 'select_account',
      access_type: 'online',
    });
    return `${AUTH_URL}?${params.toString()}`;
  },

  async exchangeCode(code, redirectUri) {
    const body = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Google token exchange failed (${resp.status}): ${text.slice(0, 200)}`);
    }
    const data = await resp.json() as { access_token?: string };
    if (!data.access_token) {
      throw new Error('Google token exchange: missing access_token in response');
    }
    return { access_token: data.access_token };
  },

  async fetchUserinfo(accessToken): Promise<NormalizedUser> {
    const resp = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) {
      throw new Error(`Google userinfo failed (${resp.status})`);
    }
    const u = await resp.json() as GoogleUserinfo;
    return {
      external_id: u.sub,
      email: u.email ?? null,
      name: u.name ?? null,
      avatar_url: u.picture ?? null,
    };
  },
});
