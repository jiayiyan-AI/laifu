import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

// provisionUser 内部会按 config 触达 azure (new DefaultAzureCredential) —— 整体 mock 掉, 只验证被触发一次。
const { provisionUser } = vi.hoisted(() => ({ provisionUser: vi.fn(async () => {}) }));
vi.mock('../../src/provisioning/manager.js', () => ({ provisionUser }));

// claimEmailAddress 分配邮箱；mock 掉避免真跑 DAO 逻辑。EmailTakenError 用真类，保证 instanceof 生效。
const { claimEmailAddress, EmailTakenError } = vi.hoisted(() => {
  class EmailTakenError extends Error {
    constructor(public localpart: string) { super(`taken: ${localpart}`); this.name = 'EmailTakenError'; }
  }
  return { claimEmailAddress: vi.fn(async () => 'mock-localpart'), EmailTakenError };
});
vi.mock('../../src/api/email-provision.js', () => ({
  claimEmailAddress,
  EmailTakenError,
  defaultLocalpart: (userId: string) => `u-${userId.replace(/-/g, '').slice(0, 8)}`,
}));

import { dao } from '../../src/db/index.js';
import { buildPurchaseRouter } from '../../src/api/purchase.js';
import { signSession } from '../../src/auth/session.js';
import { requireSession } from '../../src/auth/middleware.js';

const SECRET = 'test-secret-do-not-use-in-prod-123456';
const COOKIE_NAME = 'lingxi_sid';

describe('POST /api/purchase', () => {
  beforeEach(() => {
    vi.clearAllMocks();   // 清所有调用历史，避免 toHaveBeenCalled 跨用例累计
    claimEmailAddress.mockResolvedValue('mock-localpart');
    let inserted: any = null;
    vi.mocked(dao.containerMapping.insert).mockImplementation(async (row: any) => { inserted = row; });
    vi.mocked(dao.containerMapping.getByUserId).mockImplementation(async () => inserted ? { ...inserted, container_url: null, provisioning_step: null, error_message: null, created_at: new Date().toISOString(), ready_at: null } : null);
    vi.mocked(dao.cache.get).mockReturnValue(null);
  });

  const makeApp = () => {
    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    const mw = requireSession({ secret: SECRET, cookieName: COOKIE_NAME });
    app.use(buildPurchaseRouter(mw));
    return app;
  };

  const validCookie = (userId: string): string => {
    const token = signSession({ user_id: userId }, SECRET, 24);
    return `${COOKIE_NAME}=${token}`;
  };

  it('inserts container_mapping row, returns provisioning, kicks off async task', async () => {
    const res = await request(makeApp())
      .post('/api/purchase')
      .send({ assistant_name: '小林' })
      .set('Cookie', validCookie('u1'));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('provisioning');
    expect(res.body.user_id).toBe('u1');
    expect(dao.containerMapping.insert).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'u1', assistant_name: '小林' }));
    expect(provisionUser).toHaveBeenCalledOnce();
    expect(provisionUser).toHaveBeenCalledWith('u1');
  });

  it('带用户自填 email_localpart → 小写后传给 claimEmailAddress', async () => {
    const res = await request(makeApp())
      .post('/api/purchase')
      .send({ assistant_name: '小林', email_localpart: 'Aria' })
      .set('Cookie', validCookie('u1'));
    expect(res.status).toBe(200);
    expect(claimEmailAddress).toHaveBeenCalledWith('u1', { localpart: 'aria', displayName: '小林' });
  });

  it('email_localpart 留空 → claimEmailAddress 收到 undefined(走默认)', async () => {
    await request(makeApp())
      .post('/api/purchase')
      .send({ assistant_name: '小林', email_localpart: '   ' })
      .set('Cookie', validCookie('u1'));
    expect(claimEmailAddress).toHaveBeenCalledWith('u1', { localpart: undefined, displayName: '小林' });
  });

  it('email_localpart 格式非法 → 400 invalid_localpart, 不认领不建容器', async () => {
    const res = await request(makeApp())
      .post('/api/purchase')
      .send({ assistant_name: '小林', email_localpart: 'ab' })  // < 3 位
      .set('Cookie', validCookie('u1'));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_localpart');
    expect(claimEmailAddress).not.toHaveBeenCalled();
    expect(dao.containerMapping.insert).not.toHaveBeenCalled();
    expect(provisionUser).not.toHaveBeenCalled();
  });

  it('email_localpart 被占用 → 409 email_taken, 不建容器不 provision', async () => {
    claimEmailAddress.mockRejectedValueOnce(new EmailTakenError('aria'));
    const res = await request(makeApp())
      .post('/api/purchase')
      .send({ assistant_name: '小林', email_localpart: 'aria' })
      .set('Cookie', validCookie('u1'));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('email_taken');
    expect(dao.containerMapping.insert).not.toHaveBeenCalled();
    expect(provisionUser).not.toHaveBeenCalled();
  });

  it('邮箱非冲突错误(DB 抖动)不阻断激活 → 仍 200 并建容器', async () => {
    claimEmailAddress.mockRejectedValueOnce(new Error('db hiccup'));
    const res = await request(makeApp())
      .post('/api/purchase')
      .send({ assistant_name: '小林' })
      .set('Cookie', validCookie('u1'));
    expect(res.status).toBe(200);
    expect(dao.containerMapping.insert).toHaveBeenCalled();
    expect(provisionUser).toHaveBeenCalledOnce();
  });

  it('400 when assistant_name missing → code invalid_assistant_name', async () => {
    const res = await request(makeApp())
      .post('/api/purchase')
      .set('Cookie', validCookie('u1'));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_assistant_name');
    expect(provisionUser).not.toHaveBeenCalled();
  });

  it('400 when assistant_name is empty string', async () => {
    const res = await request(makeApp())
      .post('/api/purchase')
      .send({ assistant_name: '   ' })
      .set('Cookie', validCookie('u1'));
    expect(res.status).toBe(400);
    expect(provisionUser).not.toHaveBeenCalled();
  });

  it('401 when no session cookie', async () => {
    const res = await request(makeApp()).post('/api/purchase');
    expect(res.status).toBe(401);
    expect(provisionUser).not.toHaveBeenCalled();
  });
});
