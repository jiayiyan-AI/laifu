import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { buildOAuthRouter } from '../../src/auth/oauth.js';

const SECRET = 'test-secret-do-not-use-in-prod-123456';
const COOKIE_NAME = 'lingxi_sid';

const setup = (mode: 'dev' | 'wechat', sbOverride?: any) => {
  let upserted: any = null;
  const mockSb: any = sbOverride ?? {
    from: vi.fn(() => mockSb),
    upsert: vi.fn((row: any) => { upserted = row; return mockSb; }),
    select: vi.fn(() => mockSb),
    single: vi.fn(() => Promise.resolve({
      data: { id: 'u1', wx_unionid: upserted?.wx_unionid, nickname: upserted?.nickname ?? null, avatar_url: null },
      error: null,
    })),
    eq: vi.fn(() => mockSb),
    then: (resolve: any) => resolve({ data: null, error: null }),
  };

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(buildOAuthRouter({
    sb: mockSb,
    sessionSecret: SECRET,
    cookieName: COOKIE_NAME,
    ttlHours: 24,
    mode,
    wechat: { appId: 'wxApp', secret: 'wxSec', redirectUri: 'http://example.com/cb' },
  }));
  return { app, getUpserted: () => upserted };
};

describe('POST /api/auth/dev/login', () => {
  it('returns 200 + session cookie + user record', async () => {
    const { app, getUpserted } = setup('dev');
    const res = await request(app)
      .post('/api/auth/dev/login')
      .send({ wx_unionid: 'wx_dev_user_1', nickname: 'Alice' });
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe('u1');
    expect(res.body.nickname).toBe('Alice');
    const setCookie = res.headers['set-cookie'];
    expect(setCookie?.[0]).toMatch(new RegExp(`^${COOKIE_NAME}=`));
    expect(getUpserted()).toMatchObject({ wx_unionid: 'wx_dev_user_1', nickname: 'Alice' });
  });

  it('400 when wx_unionid missing', async () => {
    const { app } = setup('dev');
    const res = await request(app).post('/api/auth/dev/login').send({});
    expect(res.status).toBe(400);
  });

  it('404 when mode is wechat (dev endpoint disabled)', async () => {
    const { app } = setup('wechat');
    const res = await request(app)
      .post('/api/auth/dev/login')
      .send({ wx_unionid: 'wx_dev_user_1' });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/auth/wechat/start', () => {
  it('302 to open.weixin.qq.com with state cookie when mode=wechat', async () => {
    const { app } = setup('wechat');
    const res = await request(app).get('/api/auth/wechat/start');
    expect(res.status).toBe(302);
    expect(res.headers['location']).toMatch(/^https:\/\/open\.weixin\.qq\.com\/connect\/qrconnect\?/);
    expect(res.headers['location']).toContain('appid=wxApp');
    expect(res.headers['set-cookie']?.[0]).toMatch(/^wx_state=/);
  });

  it('404 when mode=dev', async () => {
    const { app } = setup('dev');
    const res = await request(app).get('/api/auth/wechat/start');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/auth/wechat/callback', () => {
  it('redirects to /desktop after exchanging code', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url: any) => {
      const s = String(url);
      if (s.includes('access_token')) {
        return new Response(JSON.stringify({
          access_token: 'ACCESS', openid: 'oOPENID', unionid: 'wx_uid_real',
        }));
      }
      if (s.includes('userinfo')) {
        return new Response(JSON.stringify({
          openid: 'oOPENID', unionid: 'wx_uid_real', nickname: 'Real',
          headimgurl: 'http://x/y.png',
        }));
      }
      throw new Error(`unexpected fetch: ${s}`);
    });

    const { app } = setup('wechat');
    const stateValue = 'mock_state_123';
    const res = await request(app)
      .get(`/api/auth/wechat/callback?code=THE_CODE&state=${stateValue}`)
      .set('Cookie', `wx_state=${stateValue}`);

    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('/desktop');
    expect(res.headers['set-cookie']?.find((c) => c.startsWith(COOKIE_NAME))).toBeTruthy();

    fetchSpy.mockRestore();
  });

  it('400 when state cookie missing or mismatched (CSRF)', async () => {
    const { app } = setup('wechat');
    const res = await request(app)
      .get('/api/auth/wechat/callback?code=THE_CODE&state=mock_state_123');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/auth/me', () => {
  it('401 when no session', async () => {
    const { app } = setup('dev');
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });
});
