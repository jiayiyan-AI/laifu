import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import type { FeishuBinding } from '../../src/db/feishu-binding-dao.js';

// --- mock dao ---
vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

// --- mock registration + probe modules ---
vi.mock('../../src/feishu/registration.js', () => ({
  beginAppRegistration: vi.fn(),
  pollAppRegistrationOnce: vi.fn(),
  getAppOwnerOpenId: vi.fn(),
}));
vi.mock('../../src/feishu/probe.js', () => ({
  probeFeishu: vi.fn(),
}));

import { dao } from '../../src/db/index.js';
import {
  beginAppRegistration,
  pollAppRegistrationOnce,
  getAppOwnerOpenId,
} from '../../src/feishu/registration.js';
import { probeFeishu } from '../../src/feishu/probe.js';
import { buildFeishuBindRouter } from '../../src/api/feishu-bind.js';
import { signSession } from '../../src/auth/session.js';
import { requireSession } from '../../src/auth/middleware.js';

const SECRET = 'test-secret-do-not-use-in-prod-1234567';
const COOKIE = 'lingxi_sid';

const userCookie = (uid: string) =>
  `${COOKIE}=${signSession({ user_id: uid }, SECRET, 24)}`;

const makeBinding = (overrides: Partial<FeishuBinding> = {}): FeishuBinding => ({
  id: 'fb_1',
  user_id: 'u_alice',
  app_id: 'cli_app',
  app_secret: 'sec_app',
  domain: 'feishu',
  owner_open_id: 'ou_owner',
  thread_id: null,
  status: 'pending_approval',
  is_active: true,
  bound_at: '2026-06-01T00:00:00Z',
  ...overrides,
});

const makeMockFeishuMgr = () => ({
  startAll: vi.fn(),
  startOne: vi.fn(),
  stopOne: vi.fn(),
  stopAll: vi.fn(),
  size: vi.fn(() => 0),
});

const makeApp = (feishuMgr: any) => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(buildFeishuBindRouter({
    feishuMgr: feishuMgr as any,
    sessionMw: requireSession({ secret: SECRET, cookieName: COOKIE }),
  }));
  return app;
};

describe('feishu-bind router', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('POST /api/feishu/bind/scan-start', () => {
    it('returns qrUrl/deviceCode/interval/expireIn from beginAppRegistration', async () => {
      vi.mocked(beginAppRegistration).mockResolvedValue({
        deviceCode: 'dc_001',
        qrUrl: 'https://accounts.feishu.cn/qr?code=abc',
        userCode: 'UC-001',
        interval: 5,
        expireIn: 300,
      });
      const res = await request(makeApp(makeMockFeishuMgr()))
        .post('/api/feishu/bind/scan-start')
        .set('Cookie', userCookie('u_alice'));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        qrUrl: 'https://accounts.feishu.cn/qr?code=abc',
        deviceCode: 'dc_001',
        interval: 5,
        expireIn: 300,
      });
    });

    it('401 without session', async () => {
      const res = await request(makeApp(makeMockFeishuMgr()))
        .post('/api/feishu/bind/scan-start');
      expect(res.status).toBe(401);
    });

    it('500 when beginAppRegistration throws', async () => {
      vi.mocked(beginAppRegistration).mockRejectedValue(new Error('boom'));
      const res = await request(makeApp(makeMockFeishuMgr()))
        .post('/api/feishu/bind/scan-start')
        .set('Cookie', userCookie('u_alice'));
      expect(res.status).toBe(500);
    });
  });

  describe('POST /api/feishu/bind/scan-poll', () => {
    const seedStart = async (app: express.Express) => {
      vi.mocked(beginAppRegistration).mockResolvedValue({
        deviceCode: 'dc_X', qrUrl: 'q', userCode: 'u', interval: 5, expireIn: 300,
      });
      await request(app).post('/api/feishu/bind/scan-start').set('Cookie', userCookie('u_alice'));
    };

    it('pending → {status:pending}', async () => {
      const app = makeApp(makeMockFeishuMgr());
      await seedStart(app);
      vi.mocked(pollAppRegistrationOnce).mockResolvedValue({ status: 'pending' });
      const res = await request(app)
        .post('/api/feishu/bind/scan-poll')
        .set('Cookie', userCookie('u_alice'))
        .send({ deviceCode: 'dc_X' });
      expect(res.body).toEqual({ status: 'pending' });
      expect(dao.feishuBindings.upsertByUserId).not.toHaveBeenCalled();
    });

    it('success → getAppOwnerOpenId + upsert + returns approved+appId+adminConsoleUrl', async () => {
      const app = makeApp(makeMockFeishuMgr());
      await seedStart(app);
      vi.mocked(pollAppRegistrationOnce).mockResolvedValue({
        status: 'success',
        result: { appId: 'cli_NEW', appSecret: 'sec_NEW', domain: 'feishu', ownerOpenId: 'ou_x' },
      });
      vi.mocked(getAppOwnerOpenId).mockResolvedValue('ou_resolved');
      vi.mocked(dao.feishuBindings.upsertByUserId).mockResolvedValue(
        makeBinding({ app_id: 'cli_NEW' }),
      );

      const res = await request(app)
        .post('/api/feishu/bind/scan-poll')
        .set('Cookie', userCookie('u_alice'))
        .send({ deviceCode: 'dc_X' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('approved');
      expect(res.body.appId).toBe('cli_NEW');
      expect(res.body.adminConsoleUrl).toContain('cli_NEW');
      expect(dao.feishuBindings.upsertByUserId).toHaveBeenCalledWith({
        userId: 'u_alice',
        appId: 'cli_NEW',
        appSecret: 'sec_NEW',
        domain: 'feishu',
        ownerOpenId: 'ou_resolved',
      });
    });

    it('denied → {status:denied}', async () => {
      const app = makeApp(makeMockFeishuMgr());
      await seedStart(app);
      vi.mocked(pollAppRegistrationOnce).mockResolvedValue({ status: 'denied' });
      const res = await request(app)
        .post('/api/feishu/bind/scan-poll')
        .set('Cookie', userCookie('u_alice'))
        .send({ deviceCode: 'dc_X' });
      expect(res.body).toEqual({ status: 'denied' });
    });

    it('expired → {status:expired}', async () => {
      const app = makeApp(makeMockFeishuMgr());
      await seedStart(app);
      vi.mocked(pollAppRegistrationOnce).mockResolvedValue({ status: 'expired' });
      const res = await request(app)
        .post('/api/feishu/bind/scan-poll')
        .set('Cookie', userCookie('u_alice'))
        .send({ deviceCode: 'dc_X' });
      expect(res.body).toEqual({ status: 'expired' });
    });

    it('400 missing deviceCode', async () => {
      const res = await request(makeApp(makeMockFeishuMgr()))
        .post('/api/feishu/bind/scan-poll')
        .set('Cookie', userCookie('u_alice'))
        .send({});
      expect(res.status).toBe(400);
    });

    it('401 without session', async () => {
      const res = await request(makeApp(makeMockFeishuMgr()))
        .post('/api/feishu/bind/scan-poll')
        .send({ deviceCode: 'dc_X' });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/feishu/bind/activate', () => {
    it('probe ok → create thread + bindThread + setActive + startOne + {ok:true}', async () => {
      vi.mocked(dao.feishuBindings.getByUserId).mockResolvedValue(makeBinding({ id: 'fb_A' }));
      vi.mocked(probeFeishu).mockResolvedValue({ ok: true, botOpenId: 'ou_bot', botName: 'Bot' });
      const feishuMgr = makeMockFeishuMgr();
      const res = await request(makeApp(feishuMgr))
        .post('/api/feishu/bind/activate')
        .set('Cookie', userCookie('u_alice'));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(dao.threads.create).toHaveBeenCalledTimes(1);
      expect(dao.feishuBindings.bindThread).toHaveBeenCalledTimes(1);
      expect(dao.feishuBindings.setActive).toHaveBeenCalledWith('fb_A', 'active');
      expect(feishuMgr.startOne).toHaveBeenCalledTimes(1);
      const startArg = feishuMgr.startOne.mock.calls[0][0];
      expect(startArg.status).toBe('active');
      expect(startArg.thread_id).toBeTruthy();
    });

    it('probe fails → 4xx with error, no activation', async () => {
      vi.mocked(dao.feishuBindings.getByUserId).mockResolvedValue(makeBinding());
      vi.mocked(probeFeishu).mockResolvedValue({ ok: false, error: 'not approved yet' });
      const feishuMgr = makeMockFeishuMgr();
      const res = await request(makeApp(feishuMgr))
        .post('/api/feishu/bind/activate')
        .set('Cookie', userCookie('u_alice'));

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(res.body.error).toBeTruthy();
      expect(dao.feishuBindings.setActive).not.toHaveBeenCalled();
      expect(feishuMgr.startOne).not.toHaveBeenCalled();
    });

    it('400 when no binding', async () => {
      vi.mocked(dao.feishuBindings.getByUserId).mockResolvedValue(null);
      const res = await request(makeApp(makeMockFeishuMgr()))
        .post('/api/feishu/bind/activate')
        .set('Cookie', userCookie('u_alice'));
      expect(res.status).toBe(400);
    });

    it('401 without session', async () => {
      const res = await request(makeApp(makeMockFeishuMgr()))
        .post('/api/feishu/bind/activate');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/feishu/bind/unbind', () => {
    it('stops connection + deactivates → {ok:true}', async () => {
      vi.mocked(dao.feishuBindings.getByUserId).mockResolvedValue(makeBinding({ id: 'fb_U' }));
      const feishuMgr = makeMockFeishuMgr();
      const res = await request(makeApp(feishuMgr))
        .post('/api/feishu/bind/unbind')
        .set('Cookie', userCookie('u_alice'));
      expect(res.body).toEqual({ ok: true });
      expect(feishuMgr.stopOne).toHaveBeenCalledWith('fb_U');
      expect(dao.feishuBindings.deactivate).toHaveBeenCalledWith('fb_U');
    });

    it('no-op when no binding — still ok:true', async () => {
      vi.mocked(dao.feishuBindings.getByUserId).mockResolvedValue(null);
      const feishuMgr = makeMockFeishuMgr();
      const res = await request(makeApp(feishuMgr))
        .post('/api/feishu/bind/unbind')
        .set('Cookie', userCookie('u_alice'));
      expect(res.body).toEqual({ ok: true });
      expect(feishuMgr.stopOne).not.toHaveBeenCalled();
    });

    it('401 without session', async () => {
      const res = await request(makeApp(makeMockFeishuMgr()))
        .post('/api/feishu/bind/unbind');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/feishu/bind', () => {
    it('bound:false when no binding', async () => {
      vi.mocked(dao.feishuBindings.getByUserId).mockResolvedValue(null);
      const res = await request(makeApp(makeMockFeishuMgr()))
        .get('/api/feishu/bind')
        .set('Cookie', userCookie('u_alice'));
      expect(res.body).toEqual({ bound: false });
    });

    it('bound:false when inactive', async () => {
      vi.mocked(dao.feishuBindings.getByUserId).mockResolvedValue(makeBinding({ is_active: false }));
      const res = await request(makeApp(makeMockFeishuMgr()))
        .get('/api/feishu/bind')
        .set('Cookie', userCookie('u_alice'));
      expect(res.body).toEqual({ bound: false });
    });

    it('bound:true with status + app_id when active', async () => {
      vi.mocked(dao.feishuBindings.getByUserId).mockResolvedValue(
        makeBinding({ is_active: true, status: 'active', app_id: 'cli_active' }),
      );
      const res = await request(makeApp(makeMockFeishuMgr()))
        .get('/api/feishu/bind')
        .set('Cookie', userCookie('u_alice'));
      expect(res.body).toEqual({ bound: true, status: 'active', app_id: 'cli_active' });
    });

    it('401 without session', async () => {
      const res = await request(makeApp(makeMockFeishuMgr())).get('/api/feishu/bind');
      expect(res.status).toBe(401);
    });
  });
});
