import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { buildWechatBindRouter } from '../../src/api/wechat-bind.js';
import { signSession } from '../../src/auth/session.js';
import { requireSession } from '../../src/auth/middleware.js';
import type { MpClient } from '../../src/wechat/mp-client.js';

const SECRET = 'test-secret-do-not-use-in-prod-1234567';
const COOKIE = 'lingxi_sid';
const TOKEN = 'shared_webhook_token';

const sigOf = (timestamp: string, nonce: string, token = TOKEN): string => {
  const sorted = [token, timestamp, nonce].sort().join('');
  return createHash('sha1').update(sorted).digest('hex');
};

// ===== 简易内存版 Supabase mock =====
// 处理: from().select().eq().maybeSingle/single
//      from().insert(row) [await]
//      from().upsert(row, {onConflict}) [await]
//      from().update(row).eq() [await]
//      from().delete().eq() [await]

interface Ctx {
  table: string;
  op: 'select' | 'insert' | 'upsert' | 'update' | 'delete' | null;
  row?: any;
  filters: [string, any][];
  upsertConflict?: string;
}

const createSbMock = () => {
  const tables: Record<string, any[]> = {
    container_mapping: [],
    wechat_bindings: [],
    wechat_bind_tickets: [],
  };
  let ctx: Ctx = { table: '', op: null, filters: [] };

  const matches = (row: any, filters: [string, any][]) =>
    filters.every(([k, v]) => row[k] === v);

  const apply = () => {
    if (!tables[ctx.table]) tables[ctx.table] = [];
    if (ctx.op === 'insert') {
      tables[ctx.table]!.push({ ...ctx.row });
      return { data: ctx.row, error: null };
    }
    if (ctx.op === 'upsert') {
      const pkCols = ctx.upsertConflict?.split(',') ?? Object.keys(ctx.row);
      const idx = tables[ctx.table]!.findIndex((r) => pkCols.every((c) => r[c] === ctx.row[c]));
      if (idx >= 0) Object.assign(tables[ctx.table]![idx], ctx.row);
      else tables[ctx.table]!.push({ ...ctx.row });
      return { data: ctx.row, error: null };
    }
    if (ctx.op === 'update') {
      tables[ctx.table]!.forEach((r) => {
        if (matches(r, ctx.filters)) Object.assign(r, ctx.row);
      });
      return { data: null, error: null };
    }
    if (ctx.op === 'delete') {
      tables[ctx.table] = tables[ctx.table]!.filter((r) => !matches(r, ctx.filters));
      return { data: null, error: null };
    }
    return { data: null, error: null };
  };

  const sb: any = {
    from(table: string) {
      ctx = { table, op: null, filters: [] };
      return sb;
    },
    select(_cols?: string) { ctx.op = 'select'; return sb; },
    insert(row: any) { ctx.op = 'insert'; ctx.row = row; return sb; },
    upsert(row: any, opts?: { onConflict?: string }) {
      ctx.op = 'upsert'; ctx.row = row; ctx.upsertConflict = opts?.onConflict; return sb;
    },
    update(row: any) { ctx.op = 'update'; ctx.row = row; return sb; },
    delete() { ctx.op = 'delete'; return sb; },
    eq(col: string, val: any) { ctx.filters.push([col, val]); return sb; },
    maybeSingle() {
      const found = tables[ctx.table]?.find((r) => matches(r, ctx.filters)) ?? null;
      return Promise.resolve({ data: found, error: null });
    },
    single() {
      const found = tables[ctx.table]?.find((r) => matches(r, ctx.filters)) ?? null;
      return Promise.resolve({
        data: found,
        error: found ? null : { code: 'PGRST116', message: 'not found' },
      });
    },
    then(onResolve: any) {
      if (ctx.op === 'select') return onResolve({ data: null, error: null });
      onResolve(apply());
    },
  };

  return { sb, tables };
};

const makeMpClient = (qrUrl = 'http://weixin.qq.com/q/abc'): MpClient => ({
  getAccessToken: vi.fn(async () => 'TOK'),
  createBindQrCode: vi.fn(async (sceneStr: string) => ({
    ticket: 'tk_' + sceneStr,
    url: qrUrl,
    expire_seconds: 600,
  })),
});

const makeApp = (sb: any, mpClient = makeMpClient()) => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(buildWechatBindRouter({
    sb,
    mpClient,
    mpToken: TOKEN,
    sessionMw: requireSession({ secret: SECRET, cookieName: COOKIE }),
  }));
  return { app, mpClient };
};

const userCookie = (userId: string) =>
  `${COOKIE}=${signSession({ user_id: userId }, SECRET, 24)}`;

describe('wechat-bind router', () => {
  beforeEach(() => vi.restoreAllMocks());

  describe('POST /api/wechat/bind/start', () => {
    it('412 when container_mapping not ready', async () => {
      const { sb, tables } = createSbMock();
      tables.container_mapping = [{ user_id: 'u1', status: 'provisioning' }];
      const { app } = makeApp(sb);

      const res = await request(app)
        .post('/api/wechat/bind/start')
        .set('Cookie', userCookie('u1'));

      expect(res.status).toBe(412);
      expect(res.body.error).toMatch(/not ready/i);
    });

    it('409 when already bound', async () => {
      const { sb, tables } = createSbMock();
      tables.container_mapping = [{ user_id: 'u1', status: 'ready' }];
      tables.wechat_bindings = [{ user_id: 'u1', mp_openid: 'oABC' }];
      const { app } = makeApp(sb);

      const res = await request(app)
        .post('/api/wechat/bind/start')
        .set('Cookie', userCookie('u1'));

      expect(res.status).toBe(409);
    });

    it('happy path: creates QR + inserts ticket + returns qr_url/token/expires_at', async () => {
      const { sb, tables } = createSbMock();
      tables.container_mapping = [{ user_id: 'u1', status: 'ready' }];
      const { app, mpClient } = makeApp(sb);

      const res = await request(app)
        .post('/api/wechat/bind/start')
        .set('Cookie', userCookie('u1'));

      expect(res.status).toBe(200);
      expect(res.body.qr_url).toBe('http://weixin.qq.com/q/abc');
      expect(typeof res.body.token).toBe('string');
      expect(res.body.token).toMatch(/^[a-f0-9]{32}$/);
      expect(typeof res.body.expires_at).toBe('string');
      // mp 调用 scene_str = 'bind_' + token
      expect(mpClient.createBindQrCode).toHaveBeenCalledWith(`bind_${res.body.token}`, 600);
      // ticket 写入
      expect(tables.wechat_bind_tickets).toHaveLength(1);
      expect(tables.wechat_bind_tickets[0]).toMatchObject({
        token: res.body.token,
        user_id: 'u1',
        ticket_url: 'http://weixin.qq.com/q/abc',
      });
    });

    it('401 without session', async () => {
      const { sb } = createSbMock();
      const { app } = makeApp(sb);
      const res = await request(app).post('/api/wechat/bind/start');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/wechat/bind/status', () => {
    it('bound:false when ticket has no mp_openid yet', async () => {
      const { sb, tables } = createSbMock();
      tables.wechat_bind_tickets = [{
        token: 'tok_x', user_id: 'u1', mp_openid: null,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      }];
      const { app } = makeApp(sb);

      const res = await request(app)
        .get('/api/wechat/bind/status?token=tok_x')
        .set('Cookie', userCookie('u1'));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ bound: false });
    });

    it('bound:true with mp_openid when ticket fulfilled', async () => {
      const { sb, tables } = createSbMock();
      tables.wechat_bind_tickets = [{
        token: 'tok_x', user_id: 'u1', mp_openid: 'oABC',
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      }];
      const { app } = makeApp(sb);

      const res = await request(app)
        .get('/api/wechat/bind/status?token=tok_x')
        .set('Cookie', userCookie('u1'));

      expect(res.body).toEqual({ bound: true, mp_openid: 'oABC' });
    });

    it('404 when token does not belong to caller (cross-user attempt)', async () => {
      const { sb, tables } = createSbMock();
      tables.wechat_bind_tickets = [{
        token: 'tok_x', user_id: 'u_other', mp_openid: null,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      }];
      const { app } = makeApp(sb);

      const res = await request(app)
        .get('/api/wechat/bind/status?token=tok_x')
        .set('Cookie', userCookie('u1'));
      expect(res.status).toBe(404);
    });

    it('400 without token query', async () => {
      const { sb } = createSbMock();
      const { app } = makeApp(sb);
      const res = await request(app)
        .get('/api/wechat/bind/status')
        .set('Cookie', userCookie('u1'));
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/wechat/bind', () => {
    it('returns bound:false when no binding', async () => {
      const { sb } = createSbMock();
      const { app } = makeApp(sb);
      const res = await request(app).get('/api/wechat/bind').set('Cookie', userCookie('u1'));
      expect(res.body).toEqual({ bound: false });
    });

    it('returns bound:true with mp_openid when bound', async () => {
      const { sb, tables } = createSbMock();
      tables.wechat_bindings = [{ user_id: 'u1', mp_openid: 'oABC' }];
      const { app } = makeApp(sb);
      const res = await request(app).get('/api/wechat/bind').set('Cookie', userCookie('u1'));
      expect(res.body).toEqual({ bound: true, mp_openid: 'oABC' });
    });
  });

  describe('DELETE /api/wechat/bind', () => {
    it('clears both wechat_bindings and pending wechat_bind_tickets for caller', async () => {
      const { sb, tables } = createSbMock();
      tables.wechat_bindings = [
        { user_id: 'u1', mp_openid: 'oA' },
        { user_id: 'u2', mp_openid: 'oB' },
      ];
      tables.wechat_bind_tickets = [
        { token: 't1', user_id: 'u1', mp_openid: null, expires_at: 'x' },
        { token: 't2', user_id: 'u2', mp_openid: null, expires_at: 'x' },
      ];
      const { app } = makeApp(sb);

      const res = await request(app).delete('/api/wechat/bind').set('Cookie', userCookie('u1'));

      expect(res.body).toEqual({ ok: true });
      expect(tables.wechat_bindings).toEqual([{ user_id: 'u2', mp_openid: 'oB' }]);
      expect(tables.wechat_bind_tickets).toEqual([{ token: 't2', user_id: 'u2', mp_openid: null, expires_at: 'x' }]);
    });
  });

  describe('GET /api/wechat/webhook (verification handshake)', () => {
    it('echos echostr when signature valid', async () => {
      const { sb } = createSbMock();
      const { app } = makeApp(sb);
      const ts = '1700000000';
      const nonce = 'nx';
      const res = await request(app).get('/api/wechat/webhook').query({
        signature: sigOf(ts, nonce), timestamp: ts, nonce, echostr: 'HELLO',
      });
      expect(res.status).toBe(200);
      expect(res.text).toBe('HELLO');
    });

    it('401 on bad signature', async () => {
      const { sb } = createSbMock();
      const { app } = makeApp(sb);
      const ts = '1700000000';
      const nonce = 'nx';
      const res = await request(app).get('/api/wechat/webhook').query({
        signature: 'deadbeef', timestamp: ts, nonce, echostr: 'X',
      });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/wechat/webhook (event push)', () => {
    const wrapEvent = (frag: string) => `<xml>${frag}</xml>`;
    const cdata = (tag: string, v: string) => `<${tag}><![CDATA[${v}]]></${tag}>`;

    const postEvent = (app: any, body: string) => {
      const ts = '1700000000';
      const nonce = 'nx';
      return request(app)
        .post('/api/wechat/webhook')
        .query({ signature: sigOf(ts, nonce), timestamp: ts, nonce })
        .set('Content-Type', 'text/xml')
        .send(body);
    };

    it('SCAN event with valid bind_<token>: inserts wechat_bindings + updates ticket', async () => {
      const { sb, tables } = createSbMock();
      tables.wechat_bind_tickets = [{
        token: 'tok_X', user_id: 'u1', mp_openid: null,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      }];
      const { app } = makeApp(sb);

      const xml = wrapEvent(
        cdata('FromUserName', 'oOPENID')
        + cdata('MsgType', 'event')
        + cdata('Event', 'SCAN')
        + cdata('EventKey', 'bind_tok_X'),
      );
      const res = await postEvent(app, xml);

      expect(res.status).toBe(200);
      expect(res.text).toBe('success');
      expect(tables.wechat_bindings).toEqual([{ user_id: 'u1', mp_openid: 'oOPENID' }]);
      expect(tables.wechat_bind_tickets[0]!.mp_openid).toBe('oOPENID');
    });

    it('subscribe event with qrscene_bind_<token>: binds (strips qrscene_ prefix)', async () => {
      const { sb, tables } = createSbMock();
      tables.wechat_bind_tickets = [{
        token: 'tok_Y', user_id: 'u2', mp_openid: null,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      }];
      const { app } = makeApp(sb);

      const xml = wrapEvent(
        cdata('FromUserName', 'oZZZ')
        + cdata('MsgType', 'event')
        + cdata('Event', 'subscribe')
        + cdata('EventKey', 'qrscene_bind_tok_Y'),
      );
      await postEvent(app, xml);

      expect(tables.wechat_bindings).toEqual([{ user_id: 'u2', mp_openid: 'oZZZ' }]);
    });

    it('idempotent: same SCAN twice → still single binding row', async () => {
      const { sb, tables } = createSbMock();
      tables.wechat_bind_tickets = [{
        token: 'tok_Z', user_id: 'u3', mp_openid: null,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      }];
      const { app } = makeApp(sb);

      const xml = wrapEvent(
        cdata('FromUserName', 'oQQQ')
        + cdata('MsgType', 'event')
        + cdata('Event', 'SCAN')
        + cdata('EventKey', 'bind_tok_Z'),
      );
      await postEvent(app, xml);
      await postEvent(app, xml);

      expect(tables.wechat_bindings).toHaveLength(1);
    });

    it('skips bind logic when ticket expired (still 200 success)', async () => {
      const { sb, tables } = createSbMock();
      tables.wechat_bind_tickets = [{
        token: 'tok_E', user_id: 'u1', mp_openid: null,
        expires_at: new Date(Date.now() - 1000).toISOString(),
      }];
      const { app } = makeApp(sb);
      const xml = wrapEvent(
        cdata('FromUserName', 'oX')
        + cdata('MsgType', 'event')
        + cdata('Event', 'SCAN')
        + cdata('EventKey', 'bind_tok_E'),
      );
      const res = await postEvent(app, xml);
      expect(res.status).toBe(200);
      expect(tables.wechat_bindings).toEqual([]);
    });

    it('unrelated MsgType (text) is silently 200 — no DB write', async () => {
      const { sb, tables } = createSbMock();
      const { app } = makeApp(sb);
      const xml = wrapEvent(cdata('FromUserName', 'oX') + cdata('MsgType', 'text') + cdata('Content', 'hi'));
      const res = await postEvent(app, xml);
      expect(res.status).toBe(200);
      expect(tables.wechat_bindings).toEqual([]);
    });

    it('401 on bad signature — never touches DB', async () => {
      const { sb, tables } = createSbMock();
      tables.wechat_bind_tickets = [{
        token: 'tok_X', user_id: 'u1', mp_openid: null,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      }];
      const { app } = makeApp(sb);
      const xml = wrapEvent(
        cdata('FromUserName', 'oOPENID')
        + cdata('MsgType', 'event')
        + cdata('Event', 'SCAN')
        + cdata('EventKey', 'bind_tok_X'),
      );
      const res = await request(app)
        .post('/api/wechat/webhook')
        .query({ signature: 'deadbeef', timestamp: '1700000000', nonce: 'nx' })
        .set('Content-Type', 'text/xml')
        .send(xml);
      expect(res.status).toBe(401);
      expect(tables.wechat_bindings).toEqual([]);
    });
  });
});
