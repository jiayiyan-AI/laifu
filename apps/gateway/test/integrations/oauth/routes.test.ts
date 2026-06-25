import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import express, { type RequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import { randomBytes } from 'node:crypto';
import { signSession } from '../../../src/auth/session.js';
import { requireSession } from '../../../src/auth/middleware.js';
import type { OauthConnection } from '../../../src/db/oauth-connections-dao.js';

// --- mock dao ---
vi.mock('../../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../../helpers/mock-dao.js');
  return mockDaoModule();
});

// config 经单例读 env: 必须在 (动态) import config/routes 之前设好。
const ENC_KEY = randomBytes(32).toString('base64');
const DEV_TOKEN = 'gho_devtoken_' + randomBytes(8).toString('hex');
process.env['PROVISIONER'] = 'local';
process.env['GITHUB_LOCAL_DEV_TOKEN'] = DEV_TOKEN;
process.env['OAUTH_TOKEN_ENCRYPTION_KEY'] = ENC_KEY;
delete process.env['GITHUB_OAUTH_CLIENT_ID'];
delete process.env['GITHUB_OAUTH_CLIENT_SECRET'];

const SECRET = 'test-secret-do-not-use-in-prod-1234567';
const COOKIE = 'lingxi_sid';
const userCookie = (uid: string) => `${COOKIE}=${signSession({ user_id: uid }, SECRET, 24)}`;

// 容器侧鉴权用读 header 的假中间件, 隔离 JWT 验证 (已在 container-token.test.ts 覆盖)。
const fakeContainerAuth: RequestHandler = (req, _res, next) => {
  const uid = req.header('x-user-id');
  if (uid) req.user_id = uid;
  next();
};

let buildOAuthRouter: typeof import('../../../src/integrations/oauth/routes.js').buildOAuthRouter;
let encryptToken: (s: string) => string;
let dao: typeof import('../../../src/db/index.js').dao;

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(buildOAuthRouter({
    sessionMw: requireSession({ secret: SECRET, cookieName: COOKIE }),
    containerAuth: fakeContainerAuth,
    publicBaseUrl: 'http://gw.test',
    frontendBaseUrl: 'http://fe.test',
  }));
  return app;
};

const makeConn = (overrides: Partial<OauthConnection> = {}): OauthConnection => ({
  id: 'oc_1',
  user_id: 'u_alice',
  provider: 'github',
  external_account_id: '12345',
  external_login: 'alice',
  encrypted_access_token: encryptToken('gho_realtoken'),
  encrypted_refresh_token: null,
  access_token_expires_at: null,
  token_scopes: ['repo', 'read:user'],
  metadata: null,
  connected_at: '2026-01-01T00:00:00.000Z',
  last_used_at: null,
  ...overrides,
});

// 真 Response (undici 全局), 不做类型 cast。
const githubUserResponse = () =>
  new Response(JSON.stringify({ id: 12345, login: 'alice' }), {
    status: 200,
    headers: { 'x-oauth-scopes': 'repo, read:user' },
  });

beforeAll(async () => {
  const routes = await import('../../../src/integrations/oauth/routes.js');
  const crypto = await import('../../../src/integrations/oauth/crypto.js');
  const db = await import('../../../src/db/index.js');
  buildOAuthRouter = routes.buildOAuthRouter;
  encryptToken = crypto.encryptToken;
  dao = db.dao;
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(dao.oauthConnections.getByUserAndProvider).mockResolvedValue(null);
  vi.mocked(dao.oauthConnections.getByProviderAccount).mockResolvedValue(null);
});

describe('oauth routes — github provider (dev shortcut mode)', () => {
  describe('unknown provider', () => {
    it('404s any unregistered provider', async () => {
      const res = await request(makeApp())
        .get('/api/me/oauth/bogus/connect-url')
        .set('Cookie', userCookie('u_alice'));
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/me/oauth/github/connect-url', () => {
    it('returns the dev-callback url in local mode', async () => {
      const res = await request(makeApp())
        .get('/api/me/oauth/github/connect-url')
        .set('Cookie', userCookie('u_alice'));
      expect(res.status).toBe(200);
      expect(res.body.dev).toBe(true);
      expect(res.body.url).toBe('http://gw.test/api/integrations/oauth/github/dev-callback');
    });

    it('401 without a session', async () => {
      const res = await request(makeApp()).get('/api/me/oauth/github/connect-url');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/integrations/oauth/github/dev-callback', () => {
    it('binds via the dev token and 302s to the frontend', async () => {
      const fetchMock = vi.fn(async () => githubUserResponse());
      vi.stubGlobal('fetch', fetchMock);

      const res = await request(makeApp())
        .get('/api/integrations/oauth/github/dev-callback')
        .set('Cookie', userCookie('u_alice'));

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('http://fe.test/desktop?github=ok');
      // fetch 用 dev token 调 GitHub /user
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const upsert = vi.mocked(dao.oauthConnections.upsertByUserAndProvider);
      expect(upsert).toHaveBeenCalledTimes(1);
      const arg = upsert.mock.calls[0]![0];
      expect(arg.userId).toBe('u_alice');
      expect(arg.provider).toBe('github');
      expect(arg.externalAccountId).toBe('12345');
      expect(arg.externalLogin).toBe('alice');
      expect(arg.tokenScopes).toEqual(['repo', 'read:user']);
      // 入库的是密文, 不是 dev token 明文
      expect(arg.encryptedAccessToken).not.toContain(DEV_TOKEN);
    });

    it('409 when the github account is linked to another user', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => githubUserResponse()));
      vi.mocked(dao.oauthConnections.getByProviderAccount).mockResolvedValue(
        makeConn({ user_id: 'u_someone_else' }),
      );
      const res = await request(makeApp())
        .get('/api/integrations/oauth/github/dev-callback')
        .set('Cookie', userCookie('u_alice'));
      expect(res.status).toBe(409);
      expect(dao.oauthConnections.upsertByUserAndProvider).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/me/oauth/github/token', () => {
    it('returns the decrypted plaintext token', async () => {
      vi.mocked(dao.oauthConnections.getByUserAndProvider).mockResolvedValue(makeConn());
      const res = await request(makeApp())
        .get('/api/me/oauth/github/token')
        .set('x-user-id', 'u_alice');
      expect(res.status).toBe(200);
      expect(res.body.token).toBe('gho_realtoken');
      expect(dao.oauthConnections.touchLastUsed).toHaveBeenCalledWith('u_alice', 'github');
    });

    it('410 when the user has no connection', async () => {
      vi.mocked(dao.oauthConnections.getByUserAndProvider).mockResolvedValue(null);
      const res = await request(makeApp())
        .get('/api/me/oauth/github/token')
        .set('x-user-id', 'u_nobody');
      expect(res.status).toBe(410);
    });

    it('401 when container auth set no user', async () => {
      const res = await request(makeApp()).get('/api/me/oauth/github/token');
      expect(res.status).toBe(401);
    });

    it('rate-limits the per-(user,provider) token endpoint (60/min window)', async () => {
      vi.mocked(dao.oauthConnections.getByUserAndProvider).mockResolvedValue(makeConn());
      const app = makeApp();
      const uid = 'u_ratelimit_' + randomBytes(4).toString('hex');
      const statuses: number[] = [];
      // 65 次快速请求 (远 < 60s 窗口): 前 60 个 200, 其余必为 429。
      for (let i = 0; i < 65; i++) {
        const res = await request(app).get('/api/me/oauth/github/token').set('x-user-id', uid);
        statuses.push(res.status);
      }
      const ok = statuses.filter((s) => s === 200).length;
      const limited = statuses.filter((s) => s === 429).length;
      expect(ok).toBe(60);
      expect(limited).toBe(5);
      expect(statuses[statuses.length - 1]).toBe(429);
    });
  });

  describe('GET /api/me/oauth/github/connection', () => {
    it('reports connected with login + scopes', async () => {
      vi.mocked(dao.oauthConnections.getByUserAndProvider).mockResolvedValue(makeConn());
      const res = await request(makeApp())
        .get('/api/me/oauth/github/connection')
        .set('Cookie', userCookie('u_alice'));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        connected: true,
        login: 'alice',
        scopes: ['repo', 'read:user'],
      });
    });

    it('reports not connected when no binding', async () => {
      vi.mocked(dao.oauthConnections.getByUserAndProvider).mockResolvedValue(null);
      const res = await request(makeApp())
        .get('/api/me/oauth/github/connection')
        .set('Cookie', userCookie('u_alice'));
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);
    });
  });

  describe('DELETE /api/me/oauth/github/connection', () => {
    it('deletes the local record and skips revoke in dev mode (no client creds)', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      vi.mocked(dao.oauthConnections.getByUserAndProvider).mockResolvedValue(makeConn());
      const res = await request(makeApp())
        .delete('/api/me/oauth/github/connection')
        .set('Cookie', userCookie('u_alice'));
      expect(res.status).toBe(200);
      expect(res.body.disconnected).toBe(true);
      expect(dao.oauthConnections.deleteByUserAndProvider).toHaveBeenCalledWith('u_alice', 'github');
      // dev 模式无 client 凭证 → 不调 GitHub revoke
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('is idempotent when there is no binding', async () => {
      vi.mocked(dao.oauthConnections.getByUserAndProvider).mockResolvedValue(null);
      const res = await request(makeApp())
        .delete('/api/me/oauth/github/connection')
        .set('Cookie', userCookie('u_alice'));
      expect(res.status).toBe(200);
      expect(res.body.disconnected).toBe(true);
      expect(dao.oauthConnections.deleteByUserAndProvider).not.toHaveBeenCalled();
    });
  });
});
