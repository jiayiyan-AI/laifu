import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { buildCloudRouter } from '../../src/api/cloud.js';
import { signLaifuUserToken } from '../../src/lib/gateway-token.js';
import type { RequestHandler } from 'express';

const SECRET = 'test-secret-1234567890';
const USER_ID = '6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f';
const ACCOUNT = 'stlingxidev';
const CONTAINER = 'laifu-cloud';
const BLOB_ENDPOINT = `https://${ACCOUNT}.blob.core.windows.net`;

function mockSession(): RequestHandler {
  return (req, _res, next) => { (req as any).session = { user_id: USER_ID }; next(); };
}

function fakeUdk() {
  const now = new Date();
  return {
    signedObjectId: '00000000-0000-0000-0000-000000000001',
    signedTenantId: '00000000-0000-0000-0000-000000000002',
    signedStartsOn: now.toISOString(),
    signedExpiresOn: new Date(now.getTime() + 7 * 24 * 3600 * 1000).toISOString(),
    signedService: 'b',
    signedVersion: '2020-02-10',
    value: Buffer.from('a'.repeat(32)).toString('base64'),
  };
}

function makeApp(opts: {
  listActive?: ReturnType<typeof vi.fn>;
  getTokenVersion?: ReturnType<typeof vi.fn>;
  getUdk?: ReturnType<typeof vi.fn>;
  listBlobsByHierarchy?: any;
  blobHeadResp?: any;
}) {
  const app = express();
  app.use(express.json());
  app.use(buildCloudRouter({
    secret: SECRET,
    config: { accountName: ACCOUNT, container: CONTAINER, blobEndpoint: BLOB_ENDPOINT, writeSasTtlSeconds: 900, readSasTtlSeconds: 300 },
    entitlements: {
      listActive: opts.listActive ?? vi.fn().mockResolvedValue(['cloud']),
      getTokenVersion: opts.getTokenVersion ?? vi.fn().mockResolvedValue(0),
    } as any,
    udkCache: { get: opts.getUdk ?? vi.fn().mockResolvedValue(fakeUdk()) } as any,
    blobServiceClient: {
      getContainerClient: () => ({
        listBlobsByHierarchy: opts.listBlobsByHierarchy ?? (() => emptyIterable()),
        getBlobClient: (_name: string) => ({
          getProperties: () => opts.blobHeadResp ?? Promise.resolve({
            contentType: 'application/pdf',
            contentLength: 123,
            lastModified: new Date(),
            metadata: { title: Buffer.from('Q2 Report').toString('base64') },
          }),
        }),
      }),
    } as any,
    sessionMw: mockSession(),
  }));
  return app;
}

async function* emptyIterable() { /* empty */ }

function bearerHeader(): string {
  return `Bearer ${signLaifuUserToken({ userId: USER_ID, tokenVersion: 0, secret: SECRET })}`;
}

describe('GET /api/cloud/sas', () => {
  it('returns CloudWriteSasResponse for entitled container', async () => {
    const res = await request(makeApp({})).get('/api/cloud/sas').set('Authorization', bearerHeader());
    expect(res.status).toBe(200);
    expect(res.body.blob_endpoint).toBe(BLOB_ENDPOINT);
    expect(res.body.container).toBe(CONTAINER);
    expect(res.body.prefix).toBe(`${USER_ID}/`);
    expect(typeof res.body.sas_token).toBe('string');
    expect(res.body.sas_token).toMatch(/sr=d/);
    expect(res.body.sas_token).toMatch(/sdd=1/);
    expect(res.body.expires_at).toMatch(/T.*Z/);
  });

  it('403 when entitlement cloud not active', async () => {
    const app = makeApp({ listActive: vi.fn().mockResolvedValue([]) });
    const res = await request(app).get('/api/cloud/sas').set('Authorization', bearerHeader());
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/cloud|entitlement/i);
  });

  it('401 without bearer token', async () => {
    const res = await request(makeApp({})).get('/api/cloud/sas');
    expect(res.status).toBe(401);
  });

  it('500 when UDK fetch fails', async () => {
    const app = makeApp({ getUdk: vi.fn().mockRejectedValue(new Error('udk down')) });
    const res = await request(app).get('/api/cloud/sas').set('Authorization', bearerHeader());
    expect(res.status).toBe(500);
  });
});

describe('GET /api/cloud/list', () => {
  function fakeListBlobs(items: Array<{ kind: 'prefix' | 'blob'; name: string; meta?: any; size?: number; contentType?: string }>) {
    return async function* () {
      for (const i of items) {
        if (i.kind === 'prefix') {
          yield { kind: 'prefix', name: i.name };
        } else {
          yield {
            kind: 'blob',
            name: i.name,
            properties: {
              contentLength: i.size ?? 0,
              lastModified: new Date('2026-06-02T10:00:00Z'),
              contentType: i.contentType ?? 'application/pdf',
            },
            metadata: i.meta ?? {},
          };
        }
      }
    };
  }

  function makeListApp(opts: { listFn?: any; listActive?: any; sessionUserId?: string }) {
    const userId = opts.sessionUserId ?? USER_ID;
    const app = express();
    app.use(express.json());
    app.use(buildCloudRouter({
      secret: SECRET,
      config: { accountName: ACCOUNT, container: CONTAINER, blobEndpoint: BLOB_ENDPOINT, writeSasTtlSeconds: 900, readSasTtlSeconds: 300 },
      entitlements: {
        listActive: opts.listActive ?? vi.fn().mockResolvedValue(['cloud']),
        getTokenVersion: vi.fn().mockResolvedValue(0),
      } as any,
      udkCache: { get: vi.fn() } as any,
      blobServiceClient: {
        getContainerClient: () => ({
          listBlobsByHierarchy: opts.listFn ?? (() => fakeListBlobs([])()),
          getBlobClient: () => ({ getProperties: vi.fn() }),
        }),
      } as any,
      sessionMw: ((req: any, _res: any, next: any) => { req.session = { user_id: userId }; next(); }) as any,
    }));
    return app;
  }

  it('returns folders and files at root for entitled user', async () => {
    const listFn = vi.fn(() => fakeListBlobs([
      { kind: 'prefix', name: `${USER_ID}/reports/` },
      { kind: 'blob', name: `${USER_ID}/q2.pdf`, size: 1024, contentType: 'application/pdf',
        meta: { title: Buffer.from('Q2 Sales').toString('base64'), session_id: 'main' } },
    ])());
    const app = makeListApp({ listFn });
    const res = await request(app).get('/api/cloud/list');
    expect(res.status).toBe(200);
    expect(res.body.folders).toEqual([{ virtual_path: 'reports/' }]);
    expect(res.body.files).toHaveLength(1);
    expect(res.body.files[0].virtual_path).toBe('q2.pdf');
    expect(res.body.files[0].size).toBe(1024);
    expect(res.body.files[0].metadata.title).toBe('Q2 Sales');
    expect(res.body.files[0].metadata.session_id).toBe('main');
  });

  it('respects prefix query parameter', async () => {
    const listFn = vi.fn(() => fakeListBlobs([
      { kind: 'blob', name: `${USER_ID}/reports/q1.pdf`, size: 200 },
    ])());
    const app = makeListApp({ listFn });
    const res = await request(app).get('/api/cloud/list?prefix=reports/');
    expect(res.status).toBe(200);
    expect(res.body.files[0].virtual_path).toBe('reports/q1.pdf');
    expect(listFn.mock.calls[0][1].prefix).toBe(`${USER_ID}/reports/`);
  });

  it('rejects prefix with .. (path traversal)', async () => {
    const app = makeListApp({});
    const res = await request(app).get('/api/cloud/list?prefix=../other/');
    expect(res.status).toBe(400);
  });

  it('rejects prefix starting with / (absolute)', async () => {
    const app = makeListApp({});
    const res = await request(app).get('/api/cloud/list?prefix=/abs/');
    expect(res.status).toBe(400);
  });

  it('403 when cloud entitlement not active', async () => {
    const app = makeListApp({ listActive: vi.fn().mockResolvedValue([]) });
    const res = await request(app).get('/api/cloud/list');
    expect(res.status).toBe(403);
  });

  it('decodes Chinese title from metadata base64', async () => {
    const listFn = vi.fn(() => fakeListBlobs([
      { kind: 'blob', name: `${USER_ID}/销售.pdf`, size: 100,
        meta: { title: Buffer.from('销售报告').toString('base64'),
                description: Buffer.from('Q2 季度').toString('base64'),
                tags: Buffer.from('a,b,c').toString('base64') } },
    ])());
    const app = makeListApp({ listFn });
    const res = await request(app).get('/api/cloud/list');
    expect(res.body.files[0].metadata.title).toBe('销售报告');
    expect(res.body.files[0].metadata.description).toBe('Q2 季度');
    expect(res.body.files[0].metadata.tags).toEqual(['a', 'b', 'c']);
  });

  it('handles file without metadata (placeholder strings/null)', async () => {
    const listFn = vi.fn(() => fakeListBlobs([
      { kind: 'blob', name: `${USER_ID}/x.txt`, size: 0, meta: {} },
    ])());
    const app = makeListApp({ listFn });
    const res = await request(app).get('/api/cloud/list');
    expect(res.status).toBe(200);
    expect(res.body.files[0].metadata.title).toBe('x.txt');
    expect(res.body.files[0].metadata.session_id).toBeNull();
  });
});
