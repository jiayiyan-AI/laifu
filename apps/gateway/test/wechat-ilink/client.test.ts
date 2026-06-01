import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getBotQrcode,
  pollQrcodeStatus,
  makeIlinkClient,
  ILINK_DEFAULT_BASE_URL,
} from '../../src/wechat-ilink/client.js';

const expectIlinkHeaders = (headers: HeadersInit | undefined, authed: boolean) => {
  const h = new Headers(headers as any);
  expect(h.get('iLink-App-Id')).toBe('bot');
  expect(h.get('iLink-App-ClientVersion')).toBe('65536');
  if (authed) {
    expect(h.get('AuthorizationType')).toBe('ilink_bot_token');
    expect(h.get('Authorization')).toMatch(/^Bearer\s+\S+/);
    expect(h.get('X-WECHAT-UIN')).toBeTruthy();
    expect(h.get('Content-Type')).toBe('application/json');
  }
};

describe('iLink client', () => {
  beforeEach(() => vi.restoreAllMocks());

  describe('getBotQrcode', () => {
    it('GET /ilink/bot/get_bot_qrcode?bot_type=3, returns qrcode + qr_content (raw payload, not URL)', async () => {
      const spy = vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({
          qrcode: 'sess_abc',
          qrcode_img_content: 'ilink://login?token=xyz',
        })),
      );

      const result = await getBotQrcode();

      expect(result).toEqual({ qrcode: 'sess_abc', qr_content: 'ilink://login?token=xyz' });
      const [url, init] = spy.mock.calls[0]!;
      expect(url).toBe(`${ILINK_DEFAULT_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`);
      expect((init as RequestInit).method ?? 'GET').toBe('GET');
      expectIlinkHeaders((init as RequestInit).headers, false);
    });

    it('respects custom baseUrl', async () => {
      const spy = vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ qrcode: 'x', qrcode_img_content: '' })),
      );
      await getBotQrcode('https://other.ilink');
      expect(spy.mock.calls[0]![0]).toBe('https://other.ilink/ilink/bot/get_bot_qrcode?bot_type=3');
    });
  });

  describe('pollQrcodeStatus', () => {
    it('wait status', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ status: 'wait' })),
      );
      const r = await pollQrcodeStatus('sess_abc');
      expect(r).toEqual({ status: 'wait' });
    });

    it('scaned status', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ status: 'scaned' })),
      );
      expect(await pollQrcodeStatus('s')).toEqual({ status: 'scaned' });
    });

    it('expired status', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ status: 'expired' })),
      );
      expect(await pollQrcodeStatus('s')).toEqual({ status: 'expired' });
    });

    it('confirmed status carries bot_token / ilink_bot_id / base_url', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({
          status: 'confirmed',
          bot_token: 'tok_xyz',
          ilink_bot_id: 'ibot_42',
          baseurl: 'https://ilink-shanghai.example',
        })),
      );
      expect(await pollQrcodeStatus('s')).toEqual({
        status: 'confirmed',
        bot_token: 'tok_xyz',
        ilink_bot_id: 'ibot_42',
        base_url: 'https://ilink-shanghai.example',
      });
    });

    it('falls back to default base_url when iLink omits baseurl on confirmed', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({
          status: 'confirmed',
          bot_token: 'tok', ilink_bot_id: 'ibot',
        })),
      );
      const r = await pollQrcodeStatus('s');
      if (r.status !== 'confirmed') throw new Error('want confirmed');
      expect(r.base_url).toBe(ILINK_DEFAULT_BASE_URL);
    });

    it('scaned_but_redirect carries redirect_host', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({
          status: 'scaned_but_redirect',
          redirect_host: 'https://ilink-shanghai.example',
        })),
      );
      expect(await pollQrcodeStatus('s')).toEqual({
        status: 'scaned_but_redirect',
        redirect_host: 'https://ilink-shanghai.example',
      });
    });

    it('returns wait on fetch failure (graceful retry)', async () => {
      vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network'));
      expect(await pollQrcodeStatus('s')).toEqual({ status: 'wait' });
    });
  });

  describe('makeIlinkClient', () => {
    const opts = { botToken: 'tok_xyz', baseUrl: 'https://ilink-shanghai.example' };

    describe('getUpdates', () => {
      it('POSTs /ilink/bot/getupdates with cursor + base_info, returns errcode/msgs/buf', async () => {
        const spy = vi.spyOn(global, 'fetch').mockResolvedValue(
          new Response(JSON.stringify({
            errcode: 0,
            msgs: [{ message_id: 'm1' }],
            get_updates_buf: 'cur_2',
          })),
        );
        const client = makeIlinkClient(opts);
        const ac = new AbortController();
        const result = await client.getUpdates('cur_1', { timeoutMs: 100, signal: ac.signal });

        expect(result).toEqual({
          errcode: 0,
          msgs: [{ message_id: 'm1' }],
          get_updates_buf: 'cur_2',
        });
        const [url, init] = spy.mock.calls[0]!;
        expect(url).toBe(`${opts.baseUrl}/ilink/bot/getupdates`);
        expect((init as RequestInit).method).toBe('POST');
        expectIlinkHeaders((init as RequestInit).headers, true);
        const body = JSON.parse((init as RequestInit).body as string);
        expect(body).toEqual({
          get_updates_buf: 'cur_1',
          base_info: { channel_version: '1.0.0' },
        });
      });

      it('null cursor → empty string in body', async () => {
        const spy = vi.spyOn(global, 'fetch').mockResolvedValue(
          new Response(JSON.stringify({ errcode: 0, msgs: [], get_updates_buf: '' })),
        );
        const client = makeIlinkClient(opts);
        await client.getUpdates(null, { timeoutMs: 100, signal: new AbortController().signal });
        const body = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string);
        expect(body.get_updates_buf).toBe('');
      });

      it('errcode=-14 (session expired) is surfaced not thrown', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(
          new Response(JSON.stringify({ errcode: -14, msgs: [], get_updates_buf: '' })),
        );
        const client = makeIlinkClient(opts);
        const r = await client.getUpdates(null, { timeoutMs: 100, signal: new AbortController().signal });
        expect(r.errcode).toBe(-14);
      });

      it('fetch abort signal propagates: rejects with AbortError', async () => {
        // 模拟 fetch 把 signal abort 透传 → reject AbortError
        vi.spyOn(global, 'fetch').mockImplementation((_url, init) => {
          return new Promise((_resolve, reject) => {
            const sig = (init as RequestInit | undefined)?.signal;
            sig?.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          });
        });
        const client = makeIlinkClient(opts);
        const ac = new AbortController();
        const promise = client.getUpdates(null, { timeoutMs: 5000, signal: ac.signal });
        ac.abort();
        await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
      });
    });

    describe('sendText', () => {
      it('POSTs /ilink/bot/sendmessage with text item_list', async () => {
        const spy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 200 }));
        const client = makeIlinkClient(opts);

        await client.sendText({
          to_user_id: 'wxid_friend',
          text: '你好',
          context_token: 'ctx_abc',
        });

        const [url, init] = spy.mock.calls[0]!;
        expect(url).toBe(`${opts.baseUrl}/ilink/bot/sendmessage`);
        expect((init as RequestInit).method).toBe('POST');
        expectIlinkHeaders((init as RequestInit).headers, true);

        const body = JSON.parse((init as RequestInit).body as string);
        expect(body.msg).toMatchObject({
          from_user_id: '',
          to_user_id: 'wxid_friend',
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text: '你好' } }],
          context_token: 'ctx_abc',
        });
        expect(body.msg.client_id).toMatch(/^laifu:\d+-[0-9a-f]+$/);
        expect(body.base_info).toEqual({ channel_version: '1.0.0' });
      });

      it('throws on non-2xx', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(new Response('err', { status: 500 }));
        const client = makeIlinkClient(opts);
        await expect(client.sendText({
          to_user_id: 'x', text: 't', context_token: '',
        })).rejects.toThrow(/sendmessage.*500/);
      });

      it('omits context_token from body if empty string', async () => {
        const spy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 200 }));
        const client = makeIlinkClient(opts);
        await client.sendText({ to_user_id: 'x', text: 't', context_token: '' });
        const body = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string);
        expect(body.msg.context_token).toBeUndefined();
      });
    });
  });
});
