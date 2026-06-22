import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

import { dao } from '../../src/db/index.js';
import { buildEmailRouter } from '../../src/api/email.js';
import { makeFakeProvider } from '../../src/lib/email/fake-provider.js';
import { makeResendProvider } from '../../src/lib/email/resend-provider.js';

const USER_ID = '6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f';
const SECRET = 'tsecret';

const fakeContainerAuth = (req: any, _res: any, next: any) => { req.user_id = USER_ID; next(); };

function makeApp(entitlementActive = true, withAttachments = false) {
  // Reset dao mocks each time (clearAllMocks 只清调用历史, 实现 mockResolvedValue 保留)
  vi.clearAllMocks();
  const app = express();
  app.use(express.json());
  app.use(buildEmailRouter({
    provider: makeFakeProvider(),
    config: { domain: 'mail.localhost', fromDefaultName: '灵犀助理', inboundWebhookSecret: SECRET },
    containerAuth: fakeContainerAuth as any,
    requireEmailEntitlement: ((_req: any, res: any, next: any) =>
      entitlementActive ? next() : res.status(403).json({ error: 'no email' })) as any,
    attachments: withAttachments ? {
      udkCache: { get: vi.fn().mockResolvedValue({
        signedObjectId: '1', signedTenantId: '2',
        signedStartsOn: new Date(), signedExpiresOn: new Date(Date.now()+86400000),
        signedService: 'b', signedVersion: '2020-02-10',
        value: Buffer.from('k').toString('base64'),
      }) },
      accountName: 'stlingxilaifu', container: 'email-attachments',
      blobEndpoint: 'https://stlingxilaifu.blob.core.windows.net',
      writeSasTtlSeconds: 300, readSasTtlSeconds: 300,
    } : undefined,
  }));
  return app;
}

describe('POST /api/email/inbound', () => {
  beforeEach(() => {
    vi.mocked(dao.email.findUserByLocalpart).mockResolvedValue(USER_ID);
    vi.mocked(dao.email.insertInbound).mockResolvedValue('eml_in');
  });

  it('Basic-Auth 错 → 401', async () => {
    const res = await request(makeApp()).post('/api/email/inbound')
      .auth('x', 'wrong').send({ to: 'sunco@mail.localhost', from: 'b@x' });
    expect(res.status).toBe(401);
  });

  it('缺 Authorization 头 → 401, 不落库', async () => {
    const res = await request(makeApp()).post('/api/email/inbound')
      .send({ to: 'sunco@mail.localhost', from: 'b@x' });
    expect(res.status).toBe(401);
    expect(dao.email.insertInbound).not.toHaveBeenCalled();
  });

  it('正确 secret + 已知 localpart → 落库 200', async () => {
    const res = await request(makeApp()).post('/api/email/inbound')
      .auth('cf', SECRET)
      .send({ to: 'sunco@mail.localhost', from: 'bob@supplier.com', subject: '报价', text: '请确认' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, id: 'eml_in' });
    expect(dao.email.insertInbound).toHaveBeenCalled();
  });

  it('未知 localpart → 202 丢弃, 不落库', async () => {
    vi.mocked(dao.email.findUserByLocalpart).mockResolvedValue(null);
    const res = await request(makeApp()).post('/api/email/inbound')
      .auth('cf', SECRET)
      .send({ to: 'ghost@mail.localhost', from: 'b@x' });
    expect(res.status).toBe(202);
    expect(dao.email.insertInbound).not.toHaveBeenCalled();
  });

  it('inbound commit: attachment_keys 透传到 insertInbound', async () => {
    vi.clearAllMocks();
    vi.mocked(dao.email.findUserByLocalpart).mockResolvedValue(USER_ID);
    vi.mocked(dao.email.insertInbound).mockResolvedValue('eml_1');
    // 用 resend provider(会从 body 解析 attachment_keys),其余依赖走单例 dao mock
    const app = express();
    app.use(express.json());
    app.use(buildEmailRouter({
      provider: makeResendProvider({ apiKey: 'x', domain: 'laifu.uncagedai.org' }),
      config: { domain: 'laifu.uncagedai.org', fromDefaultName: '灵犀助理', inboundWebhookSecret: SECRET },
      containerAuth: ((_req: any, _res: any, next: any) => next()) as any,
      requireEmailEntitlement: ((_req: any, _res: any, next: any) => next()) as any,
    }));

    await request(app).post('/api/email/inbound')
      .set('Authorization', 'Basic ' + Buffer.from('cf:' + SECRET).toString('base64'))
      .send({
        to: 'sunco@laifu.uncagedai.org',
        from_addr: 'b@x',
        subject: 's',
        text: 't',
        attachment_keys: [{ key: '01J-a.pdf', filename: 'a.pdf', content_type: 'application/pdf', size: 9 }],
      });

    expect(vi.mocked(dao.email.insertInbound)).toHaveBeenCalled();
    const parsedArg = vi.mocked(dao.email.insertInbound).mock.calls[0]![0];
    expect(parsedArg.attachment_keys).toHaveLength(1);
    expect(parsedArg.has_attachments).toBe(true);
  });
});

describe('GET /api/email/list', () => {
  it('entitlement 关 → 403', async () => {
    const res = await request(makeApp(false)).get('/api/email/list');
    expect(res.status).toBe(403);
  });
  it('返回列表', async () => {
    vi.mocked(dao.email.list).mockResolvedValue([{ id: 'eml_1', direction: 'inbound', from_addr: 'b@x', to_addrs: [], subject: '报价', has_attachments: false, received_at: 't' }] as any);
    const res = await request(makeApp()).get('/api/email/list').query({ q: '报价', limit: 5 });
    expect(res.status).toBe(200);
    expect(res.body.emails[0].id).toBe('eml_1');
  });
});

describe('GET /api/email/get', () => {
  it('找不到 → 404', async () => {
    vi.mocked(dao.email.get).mockResolvedValue(null);
    const res = await request(makeApp()).get('/api/email/get?id=nope');
    expect(res.status).toBe(404);
  });
  it('返回详情', async () => {
    vi.mocked(dao.email.get).mockResolvedValue({ id: 'eml_1', direction: 'inbound', from_addr: 'b@x', to_addrs: [], cc_addrs: [], subject: '报价', message_id: '<m1>', in_reply_to: null, reference_ids: [], body_text: '请确认', has_attachments: false, received_at: 't' } as any);
    const res = await request(makeApp()).get('/api/email/get?id=eml_1');
    expect(res.status).toBe(200);
    expect(res.body.email.body_text).toBe('请确认');
  });

  it('缺 id → 400', async () => {
    const res = await request(makeApp()).get('/api/email/get');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/email/send', () => {
  beforeEach(() => {
    vi.mocked(dao.email.getAddress).mockResolvedValue({ localpart: 'sunco', display_name: '顺' });
    vi.mocked(dao.email.get).mockResolvedValue({ id: 'eml_1', direction: 'inbound', from_addr: 'b@x', to_addrs: [], cc_addrs: [], subject: '报价', message_id: '<m1>', in_reply_to: null, reference_ids: [], body_text: '请确认', has_attachments: false, received_at: 't' } as any);
    vi.mocked(dao.email.insertOutbound).mockResolvedValue('eml_out');
  });

  it('reply: 带 in_reply_to_id → 线程头 + 收件人默认原发件人 + 落 outbound', async () => {
    const res = await request(makeApp()).post('/api/email/send')
      .send({ in_reply_to_id: 'eml_1', subject: 'Re: 报价', body_text: '同意', to: [] });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('eml_out');
    expect(res.body.message_id).toMatch(/@mail\.localhost>$/);
    const outRow = vi.mocked(dao.email.insertOutbound).mock.calls[0]![0];
    expect(outRow.to_addrs).toEqual(['b@x']);
    expect(outRow.in_reply_to).toBe('<m1>');
    expect(outRow.from_addr).toBe('sunco@mail.localhost');
    expect(outRow.reference_ids).toEqual(['<m1>']);
  });

  it('reply 不带 subject → 派生 "Re: 原主题"', async () => {
    const res = await request(makeApp()).post('/api/email/send')
      .send({ in_reply_to_id: 'eml_1', body_text: '同意', to: [] });
    expect(res.status).toBe(200);
    expect(vi.mocked(dao.email.insertOutbound).mock.calls[0]![0].subject).toBe('Re: 报价');
  });

  it('reply 原主题已带 Re: → 不重复加前缀', async () => {
    vi.mocked(dao.email.get).mockResolvedValue({
      id: 'eml_1', direction: 'inbound', from_addr: 'b@x', to_addrs: [], cc_addrs: [],
      subject: 'Re: 报价', message_id: '<m1>', in_reply_to: null, reference_ids: [],
      body_text: 'x', has_attachments: false, received_at: 't',
    } as any);
    const res = await request(makeApp()).post('/api/email/send')
      .send({ in_reply_to_id: 'eml_1', body_text: '同意', to: [] });
    expect(res.status).toBe(200);
    expect(vi.mocked(dao.email.insertOutbound).mock.calls[0]![0].subject).toBe('Re: 报价');
  });

  it('新发: 显式 to', async () => {
    const res = await request(makeApp()).post('/api/email/send')
      .send({ to: ['x@y.com'], subject: '询价', body_text: '在吗' });
    expect(res.status).toBe(200);
    expect(vi.mocked(dao.email.insertOutbound).mock.calls[0]![0].to_addrs).toEqual(['x@y.com']);
  });

  it('既无 to 又无 in_reply_to_id → 400', async () => {
    vi.mocked(dao.email.get).mockResolvedValue(null);
    vi.mocked(dao.email.getAddress).mockResolvedValue({ localpart: 'sunco', display_name: '顺' });
    const res = await request(makeApp()).post('/api/email/send').send({ subject: 's', body_text: 'b', to: [] });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/email/attachment', () => {
  it('校验属主 + 签 read-SAS 302', async () => {
    vi.mocked(dao.email.get).mockResolvedValue({
      id: 'eml_1', user_id: USER_ID, direction: 'inbound',
      attachment_keys: [{ key: '01J-a.pdf', filename: 'a.pdf', content_type: 'application/pdf', size: 9 }],
    } as any);
    const res = await request(makeApp(true, true)).get('/api/email/attachment?id=eml_1&idx=0');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('email-attachments/01J-a.pdf');
    expect(res.headers.location).toMatch(/sig=/);
  });

  it('idx 越界 404', async () => {
    vi.mocked(dao.email.get).mockResolvedValue({ id: 'eml_1', user_id: USER_ID, attachment_keys: [] } as any);
    const res = await request(makeApp(true, true)).get('/api/email/attachment?id=eml_1&idx=5');
    expect(res.status).toBe(404);
  });

  it('非属主(get 返回 null)→ 404', async () => {
    vi.mocked(dao.email.get).mockResolvedValue(null);
    const res = await request(makeApp(true, true)).get('/api/email/attachment?id=eml_other&idx=0');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/email/inbound/prepare', () => {
  it('已知收件人为每个附件签 write-SAS', async () => {
    vi.mocked(dao.email.findUserByLocalpart).mockResolvedValue(USER_ID);
    const res = await request(makeApp(true, true)).post('/api/email/inbound/prepare')
      .set('Authorization', 'Basic ' + Buffer.from('cf:' + SECRET).toString('base64'))
      .send({ to_localpart: 'sunco', attachments: [
        { filename: 'quote.pdf', content_type: 'application/pdf', size: 100 },
      ]});
    expect(res.status).toBe(200);
    expect(res.body.recipient).toBe('ok');
    expect(res.body.uploads).toHaveLength(1);
    expect(res.body.uploads[0]).toMatchObject({ idx: 0 });
    expect(res.body.uploads[0].key).toMatch(/^sunco\/[0-9a-f-]+-quote\.pdf$/); // localpart 目录 + uuid + 文件名
    expect(res.body.uploads[0].sas_url).toContain('email-attachments');
    expect(res.body).not.toHaveProperty('email_id');
  });

  it('未知收件人不签 SAS', async () => {
    vi.mocked(dao.email.findUserByLocalpart).mockResolvedValue(null);
    const res = await request(makeApp(true, true)).post('/api/email/inbound/prepare')
      .set('Authorization', 'Basic ' + Buffer.from('cf:' + SECRET).toString('base64'))
      .send({ to_localpart: 'nobody', attachments: [{ filename: 'a.pdf', content_type: 'x', size: 1 }] });
    expect(res.status).toBe(200);
    expect(res.body.recipient).toBe('unknown');
    expect(res.body.uploads ?? []).toHaveLength(0);
  });

  it('密钥错回 401', async () => {
    const res = await request(makeApp(true, true)).post('/api/email/inbound/prepare')
      .set('Authorization', 'Basic ' + Buffer.from('cf:wrong').toString('base64'))
      .send({ to_localpart: 'sunco', attachments: [] });
    expect(res.status).toBe(401);
  });

  it('未配置 attachments 回 501', async () => {
    const res = await request(makeApp(true, false)).post('/api/email/inbound/prepare')
      .set('Authorization', 'Basic ' + Buffer.from('cf:' + SECRET).toString('base64'))
      .send({ to_localpart: 'sunco', attachments: [] });
    expect(res.status).toBe(501);
  });

  it('缺 Authorization 头回 401', async () => {
    const res = await request(makeApp(true, true)).post('/api/email/inbound/prepare')
      .send({ to_localpart: 'sunco', attachments: [] });
    expect(res.status).toBe(401);
  });
});
