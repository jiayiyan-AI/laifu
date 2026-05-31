import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { makeMpClient, verifyWebhookSignature } from '../../src/wechat/mp-client.js';

const APP_ID = 'wx_test_app';
const APP_SECRET = 'test_secret';

describe('mp-client', () => {
  beforeEach(() => vi.restoreAllMocks());

  describe('getAccessToken', () => {
    it('first call fetches from cgi-bin/token, returns access_token', async () => {
      const spy = vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ access_token: 'TOK_1', expires_in: 7200 })),
      );
      const client = makeMpClient({ appId: APP_ID, appSecret: APP_SECRET });

      const token = await client.getAccessToken();

      expect(token).toBe('TOK_1');
      expect(spy).toHaveBeenCalledTimes(1);
      const url = spy.mock.calls[0]![0] as string;
      const parsed = new URL(url);
      expect(parsed.origin + parsed.pathname).toBe('https://api.weixin.qq.com/cgi-bin/token');
      expect(parsed.searchParams.get('grant_type')).toBe('client_credential');
      expect(parsed.searchParams.get('appid')).toBe(APP_ID);
      expect(parsed.searchParams.get('secret')).toBe(APP_SECRET);
    });

    it('caches: second call within TTL returns cache, no second fetch', async () => {
      const spy = vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ access_token: 'TOK_1', expires_in: 7200 })),
      );
      let mockNow = 1_000_000_000_000;
      const client = makeMpClient({ appId: APP_ID, appSecret: APP_SECRET, now: () => mockNow });

      await client.getAccessToken();
      mockNow += 60_000; // 1 分钟后,远小于 7200s TTL
      const second = await client.getAccessToken();

      expect(second).toBe('TOK_1');
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('refetches when cache expires (留出 5min 安全 buffer)', async () => {
      const spy = vi.spyOn(global, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'TOK_1', expires_in: 7200 })))
        .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'TOK_2', expires_in: 7200 })));
      let mockNow = 1_000_000_000_000;
      const client = makeMpClient({ appId: APP_ID, appSecret: APP_SECRET, now: () => mockNow });

      await client.getAccessToken();
      // 7200s 后再要,即便严格 TTL 还未到,client 应该提前 refetch
      mockNow += (7200 - 60) * 1000;
      const second = await client.getAccessToken();

      expect(second).toBe('TOK_2');
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('throws on wechat error response (errcode != 0)', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ errcode: 40013, errmsg: 'invalid appid' })),
      );
      const client = makeMpClient({ appId: APP_ID, appSecret: APP_SECRET });
      await expect(client.getAccessToken()).rejects.toThrow(/40013|invalid appid/i);
    });
  });

  describe('createBindQrCode', () => {
    it('POSTs cgi-bin/qrcode/create with scene_str QR_STR_SCENE, returns ticket+url', async () => {
      const spy = vi.spyOn(global, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'TOK_X', expires_in: 7200 })))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          ticket: 'gQ...ticket',
          expire_seconds: 600,
          url: 'http://weixin.qq.com/q/abc',
        })));
      const client = makeMpClient({ appId: APP_ID, appSecret: APP_SECRET });

      const result = await client.createBindQrCode('bind_abc123');

      expect(result).toEqual({
        ticket: 'gQ...ticket',
        url: 'http://weixin.qq.com/q/abc',
        expire_seconds: 600,
      });
      // 第二次 fetch 是 qrcode/create
      const [qrUrl, qrInit] = spy.mock.calls[1]!;
      expect(qrUrl).toBe('https://api.weixin.qq.com/cgi-bin/qrcode/create?access_token=TOK_X');
      expect((qrInit as RequestInit).method).toBe('POST');
      const body = JSON.parse((qrInit as RequestInit).body as string);
      expect(body).toEqual({
        expire_seconds: 600,
        action_name: 'QR_STR_SCENE',
        action_info: { scene: { scene_str: 'bind_abc123' } },
      });
    });

    it('throws on wechat error', async () => {
      vi.spyOn(global, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'T', expires_in: 7200 })))
        .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 40001, errmsg: 'token expired' })));
      const client = makeMpClient({ appId: APP_ID, appSecret: APP_SECRET });
      await expect(client.createBindQrCode('x')).rejects.toThrow(/40001|token expired/i);
    });
  });

  describe('verifyWebhookSignature', () => {
    const TOKEN = 'shared_token_xyz';

    const correctSig = (timestamp: string, nonce: string): string => {
      const sorted = [TOKEN, timestamp, nonce].sort().join('');
      return createHash('sha1').update(sorted).digest('hex');
    };

    it('returns true for valid sha1(sorted(token,timestamp,nonce))', () => {
      const ts = '1700000000';
      const nonce = 'random123';
      const sig = correctSig(ts, nonce);
      expect(verifyWebhookSignature(sig, ts, nonce, TOKEN)).toBe(true);
    });

    it('returns false for tampered signature', () => {
      const ts = '1700000000';
      const nonce = 'random123';
      const sig = correctSig(ts, nonce).replace(/.$/, '0');
      expect(verifyWebhookSignature(sig, ts, nonce, TOKEN)).toBe(false);
    });

    it('returns false on wrong token', () => {
      const ts = '1700000000';
      const nonce = 'random123';
      const sig = correctSig(ts, nonce);
      expect(verifyWebhookSignature(sig, ts, nonce, 'wrong_token')).toBe(false);
    });

    it('is order-independent (sorted) — swap timestamp/nonce still verifies', () => {
      const ts = 'zzzzzz';
      const nonce = 'aaaaaa';
      // 即便 ts 字典序大于 nonce, sort 后顺序还是稳定
      const sig = correctSig(ts, nonce);
      expect(verifyWebhookSignature(sig, ts, nonce, TOKEN)).toBe(true);
    });
  });
});
