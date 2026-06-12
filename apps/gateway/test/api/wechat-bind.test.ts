import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import type { WechatBinding } from '../../src/db/wechat-binding-dao.js';

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

import { dao } from '../../src/db/index.js';
import { buildWechatBindRouter } from '../../src/api/wechat-bind.js';
import { signSession } from '../../src/auth/session.js';
import { requireSession } from '../../src/auth/middleware.js';

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

const makeMockPollMgr = () => ({
  startAll: vi.fn(),
  startOne: vi.fn(),
  stopOne: vi.fn(),
  stopAll: vi.fn(),
  size: vi.fn(() => 0),
});

const makeApp = (pollMgr: any) => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(buildWechatBindRouter({
    pollMgr: pollMgr as any,
    sessionMw: requireSession({ secret: SECRET, cookieName: COOKIE }),
  }));
  return app;
};

describe('wechat-bind router', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('POST /api/wechat/bind/qr-start', () => {
    it('returns qrcode + qr_url from iLink', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({
          qrcode: 'sess_xyz',
          qrcode_img_content: 'ilink://login?token=xyz',
        })),
      );
      const pollMgr = makeMockPollMgr();
      const res = await request(makeApp(pollMgr))
        .post('/api/wechat/bind/qr-start')
        .set('Cookie', userCookie('u_alice'));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ qrcode: 'sess_xyz', qr_content: 'ilink://login?token=xyz' });
    });

    it('401 without session', async () => {
      const res = await request(makeApp(makeMockPollMgr()))
        .post('/api/wechat/bind/qr-start');
      expect(res.status).toBe(401);
    });

    it('502 on iLink failure', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 500 }));
      const res = await request(makeApp(makeMockPollMgr()))
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
      const res = await request(makeApp(makeMockPollMgr()))
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
      vi.mocked(dao.wechatBindings.upsertByUserId).mockResolvedValue(makeBinding({ id: 'bind_new', ilink_bot_id: 'ibot_NEW' }));
      const pollMgr = makeMockPollMgr();
      const res = await request(makeApp(pollMgr))
        .post('/api/wechat/bind/qr-poll')
        .set('Cookie', userCookie('u_alice'))
        .send({ qrcode: 'sess_xyz' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        status: 'confirmed', bound: true, ilink_bot_id: 'ibot_NEW',
      });
      expect(dao.wechatBindings.upsertByUserId).toHaveBeenCalledWith({
        user_id: 'u_alice',
        ilink_bot_id: 'ibot_NEW',
        bot_token: 'tk_NEW',
        base_url: 'https://ilink-shanghai',
      });
      expect(pollMgr.startOne).toHaveBeenCalledTimes(1);
    });

    it('400 missing qrcode', async () => {
      const res = await request(makeApp(makeMockPollMgr()))
        .post('/api/wechat/bind/qr-poll')
        .set('Cookie', userCookie('u_alice'))
        .send({});
      expect(res.status).toBe(400);
    });

    it('401 without session', async () => {
      const res = await request(makeApp(makeMockPollMgr()))
        .post('/api/wechat/bind/qr-poll')
        .send({ qrcode: 'x' });
      expect(res.status).toBe(401);
    });

    it('expired status passthrough — no DB write, no startOne', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ status: 'expired' })),
      );
      const pollMgr = makeMockPollMgr();
      const res = await request(makeApp(pollMgr))
        .post('/api/wechat/bind/qr-poll')
        .set('Cookie', userCookie('u_alice'))
        .send({ qrcode: 'sess' });
      expect(res.body).toEqual({ status: 'expired' });
      expect(dao.wechatBindings.upsertByUserId).not.toHaveBeenCalled();
      expect(pollMgr.startOne).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/wechat/bind', () => {
    it('bound:false when no binding', async () => {
      vi.mocked(dao.wechatBindings.getByUserId).mockResolvedValue(null);
      const res = await request(makeApp(makeMockPollMgr()))
        .get('/api/wechat/bind')
        .set('Cookie', userCookie('u_alice'));
      expect(res.body).toEqual({ bound: false });
    });

    it('bound:false when row exists but is_active=false', async () => {
      vi.mocked(dao.wechatBindings.getByUserId).mockResolvedValue(makeBinding({ is_active: false }));
      const res = await request(makeApp(makeMockPollMgr()))
        .get('/api/wechat/bind')
        .set('Cookie', userCookie('u_alice'));
      expect(res.body).toEqual({ bound: false });
    });

    it('bound:true with ilink_bot_id + bound_at when active', async () => {
      vi.mocked(dao.wechatBindings.getByUserId).mockResolvedValue(makeBinding({ is_active: true, ilink_bot_id: 'ibot_active' }));
      const res = await request(makeApp(makeMockPollMgr()))
        .get('/api/wechat/bind')
        .set('Cookie', userCookie('u_alice'));
      expect(res.body).toEqual({
        bound: true,
        ilink_bot_id: 'ibot_active',
        bound_at: '2026-06-01T00:00:00Z',
      });
    });

    it('401 without session', async () => {
      const res = await request(makeApp(makeMockPollMgr())).get('/api/wechat/bind');
      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /api/wechat/bind', () => {
    it('stops poller + deactivates when active binding exists', async () => {
      vi.mocked(dao.wechatBindings.getByUserId).mockResolvedValue(makeBinding({ id: 'bind_X', is_active: true }));
      const pollMgr = makeMockPollMgr();
      const res = await request(makeApp(pollMgr))
        .delete('/api/wechat/bind')
        .set('Cookie', userCookie('u_alice'));
      expect(res.body).toEqual({ ok: true });
      expect(pollMgr.stopOne).toHaveBeenCalledWith('bind_X');
      expect(dao.wechatBindings.deactivate).toHaveBeenCalledWith('bind_X');
    });

    it('no-op when no binding — still returns ok:true', async () => {
      vi.mocked(dao.wechatBindings.getByUserId).mockResolvedValue(null);
      const pollMgr = makeMockPollMgr();
      const res = await request(makeApp(pollMgr))
        .delete('/api/wechat/bind')
        .set('Cookie', userCookie('u_alice'));
      expect(res.body).toEqual({ ok: true });
      expect(pollMgr.stopOne).not.toHaveBeenCalled();
      expect(dao.wechatBindings.deactivate).not.toHaveBeenCalled();
    });

    it('no-op when binding already inactive', async () => {
      vi.mocked(dao.wechatBindings.getByUserId).mockResolvedValue(makeBinding({ is_active: false }));
      const pollMgr = makeMockPollMgr();
      const res = await request(makeApp(pollMgr))
        .delete('/api/wechat/bind')
        .set('Cookie', userCookie('u_alice'));
      expect(res.body).toEqual({ ok: true });
      expect(pollMgr.stopOne).not.toHaveBeenCalled();
    });

    it('401 without session', async () => {
      const res = await request(makeApp(makeMockPollMgr())).delete('/api/wechat/bind');
      expect(res.status).toBe(401);
    });
  });
});
