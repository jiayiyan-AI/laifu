import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { buildWechatBindRouter } from '../../src/api/wechat-bind.js';
import { signSession } from '../../src/auth/session.js';
import { requireSession } from '../../src/auth/middleware.js';
import type { WechatBinding, WechatBindingDao } from '../../src/db/wechat-binding-dao.js';

const SECRET = 'test-secret-do-not-use-in-prod-1234567';
const COOKIE = 'lingxi_sid';

const userCookie = (uid: string) =>
  `${COOKIE}=${signSession({ user_id: uid }, SECRET, 24)}`;

const makeBinding = (overrides: Partial<WechatBinding> = {}): WechatBinding => ({
  id: 'bind_1',
  user_id: 'u_alice',
  ilink_bot_id: 'ibot_alice',
  bot_token: 'tok',
  base_url: 'https://ilink',
  updates_cursor: null,
  is_active: true,
  thread_id: null,
  bound_at: '2026-06-01T00:00:00Z',
  ...overrides,
});

const makeMockDao = (initial: WechatBinding | null = null): WechatBindingDao & {
  __row: WechatBinding | null;
  __deactivated: string[];
} => ({
  __row: initial,
  __deactivated: [],
  listActive: vi.fn(),
  getByUserId: vi.fn(async function (this: any) { return this.__row; }),
  upsertByUserId: vi.fn(async function (this: any, args: any) {
    this.__row = makeBinding({ ...args, id: 'bind_new' });
    return this.__row;
  }),
  updateCursor: vi.fn(),
  bindThread: vi.fn(),
  deactivate: vi.fn(async function (this: any, id: string) {
    this.__deactivated.push(id);
    if (this.__row) this.__row.is_active = false;
  }),
} as any);

const makeMockPollMgr = () => ({
  startAll: vi.fn(),
  startOne: vi.fn(),
  stopOne: vi.fn(),
  stopAll: vi.fn(),
  size: vi.fn(() => 0),
});

const makeApp = (dao: any, pollMgr: any) => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(buildWechatBindRouter({
    dao,
    pollMgr: pollMgr as any,
    sessionMw: requireSession({ secret: SECRET, cookieName: COOKIE }),
  }));
  return app;
};

describe('wechat-bind router', () => {
  beforeEach(() => vi.restoreAllMocks());

  describe('POST /api/wechat/bind/qr-start', () => {
    it('returns qrcode + qr_url from iLink', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({
          qrcode: 'sess_xyz',
          qrcode_img_content: 'https://qr.png',
        })),
      );
      const dao = makeMockDao();
      const pollMgr = makeMockPollMgr();
      const res = await request(makeApp(dao, pollMgr))
        .post('/api/wechat/bind/qr-start')
        .set('Cookie', userCookie('u_alice'));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ qrcode: 'sess_xyz', qr_url: 'https://qr.png' });
    });

    it('401 without session', async () => {
      const res = await request(makeApp(makeMockDao(), makeMockPollMgr()))
        .post('/api/wechat/bind/qr-start');
      expect(res.status).toBe(401);
    });

    it('502 on iLink failure', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 500 }));
      const res = await request(makeApp(makeMockDao(), makeMockPollMgr()))
        .post('/api/wechat/bind/qr-start')
        .set('Cookie', userCookie('u_alice'));
      expect(res.status).toBe(502);
    });
  });

  describe('POST /api/wechat/bind/qr-poll', () => {
    it('wait status passthrough', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ status: 'wait' })),
      );
      const res = await request(makeApp(makeMockDao(), makeMockPollMgr()))
        .post('/api/wechat/bind/qr-poll')
        .set('Cookie', userCookie('u_alice'))
        .send({ qrcode: 'sess' });
      expect(res.body).toEqual({ status: 'wait' });
    });

    it('confirmed: upsert + pollMgr.startOne + returns confirmed body', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({
          status: 'confirmed',
          bot_token: 'tk_NEW',
          ilink_bot_id: 'ibot_NEW',
          baseurl: 'https://ilink-shanghai',
        })),
      );
      const dao = makeMockDao();
      const pollMgr = makeMockPollMgr();
      const res = await request(makeApp(dao, pollMgr))
        .post('/api/wechat/bind/qr-poll')
        .set('Cookie', userCookie('u_alice'))
        .send({ qrcode: 'sess_xyz' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        status: 'confirmed', bound: true, ilink_bot_id: 'ibot_NEW',
      });
      expect(dao.upsertByUserId).toHaveBeenCalledWith({
        user_id: 'u_alice',
        ilink_bot_id: 'ibot_NEW',
        bot_token: 'tk_NEW',
        base_url: 'https://ilink-shanghai',
      });
      expect(pollMgr.startOne).toHaveBeenCalledTimes(1);
    });

    it('400 missing qrcode', async () => {
      const res = await request(makeApp(makeMockDao(), makeMockPollMgr()))
        .post('/api/wechat/bind/qr-poll')
        .set('Cookie', userCookie('u_alice'))
        .send({});
      expect(res.status).toBe(400);
    });

    it('401 without session', async () => {
      const res = await request(makeApp(makeMockDao(), makeMockPollMgr()))
        .post('/api/wechat/bind/qr-poll')
        .send({ qrcode: 'x' });
      expect(res.status).toBe(401);
    });

    it('expired status passthrough — no DB write, no startOne', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ status: 'expired' })),
      );
      const dao = makeMockDao();
      const pollMgr = makeMockPollMgr();
      const res = await request(makeApp(dao, pollMgr))
        .post('/api/wechat/bind/qr-poll')
        .set('Cookie', userCookie('u_alice'))
        .send({ qrcode: 'sess' });
      expect(res.body).toEqual({ status: 'expired' });
      expect(dao.upsertByUserId).not.toHaveBeenCalled();
      expect(pollMgr.startOne).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/wechat/bind', () => {
    it('bound:false when no binding', async () => {
      const res = await request(makeApp(makeMockDao(null), makeMockPollMgr()))
        .get('/api/wechat/bind')
        .set('Cookie', userCookie('u_alice'));
      expect(res.body).toEqual({ bound: false });
    });

    it('bound:false when row exists but is_active=false', async () => {
      const dao = makeMockDao(makeBinding({ is_active: false }));
      const res = await request(makeApp(dao, makeMockPollMgr()))
        .get('/api/wechat/bind')
        .set('Cookie', userCookie('u_alice'));
      expect(res.body).toEqual({ bound: false });
    });

    it('bound:true with ilink_bot_id + bound_at when active', async () => {
      const dao = makeMockDao(makeBinding({ is_active: true, ilink_bot_id: 'ibot_active' }));
      const res = await request(makeApp(dao, makeMockPollMgr()))
        .get('/api/wechat/bind')
        .set('Cookie', userCookie('u_alice'));
      expect(res.body).toEqual({
        bound: true,
        ilink_bot_id: 'ibot_active',
        bound_at: '2026-06-01T00:00:00Z',
      });
    });

    it('401 without session', async () => {
      const res = await request(makeApp(makeMockDao(), makeMockPollMgr())).get('/api/wechat/bind');
      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /api/wechat/bind', () => {
    it('stops poller + deactivates when active binding exists', async () => {
      const dao = makeMockDao(makeBinding({ id: 'bind_X', is_active: true }));
      const pollMgr = makeMockPollMgr();
      const res = await request(makeApp(dao, pollMgr))
        .delete('/api/wechat/bind')
        .set('Cookie', userCookie('u_alice'));
      expect(res.body).toEqual({ ok: true });
      expect(pollMgr.stopOne).toHaveBeenCalledWith('bind_X');
      expect(dao.__deactivated).toContain('bind_X');
    });

    it('no-op when no binding — still returns ok:true', async () => {
      const dao = makeMockDao(null);
      const pollMgr = makeMockPollMgr();
      const res = await request(makeApp(dao, pollMgr))
        .delete('/api/wechat/bind')
        .set('Cookie', userCookie('u_alice'));
      expect(res.body).toEqual({ ok: true });
      expect(pollMgr.stopOne).not.toHaveBeenCalled();
      expect(dao.deactivate).not.toHaveBeenCalled();
    });

    it('no-op when binding already inactive', async () => {
      const dao = makeMockDao(makeBinding({ is_active: false }));
      const pollMgr = makeMockPollMgr();
      const res = await request(makeApp(dao, pollMgr))
        .delete('/api/wechat/bind')
        .set('Cookie', userCookie('u_alice'));
      expect(res.body).toEqual({ ok: true });
      expect(pollMgr.stopOne).not.toHaveBeenCalled();
    });

    it('401 without session', async () => {
      const res = await request(makeApp(makeMockDao(), makeMockPollMgr())).delete('/api/wechat/bind');
      expect(res.status).toBe(401);
    });
  });
});
