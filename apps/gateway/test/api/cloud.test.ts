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
