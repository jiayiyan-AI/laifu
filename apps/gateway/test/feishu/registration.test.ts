/**
 * Tests for feishu/registration.ts (device-code 扫码建飞书应用)
 *
 * 字段名以源文件真实响应字段为准:
 *   begin 响应: device_code, verification_uri_complete, user_code, interval, expire_in
 *   poll  响应: client_id, client_secret, user_info.open_id, error, error_description
 */
import { describe, it, expect, vi } from 'vitest';
import {
  beginAppRegistration,
  pollAppRegistration,
  getAppOwnerOpenId,
} from '../../src/feishu/registration.js';

// ---------------------------------------------------------------------------
// Helper: 构造一个返回固定 JSON 的 fetch mock 响应
// ---------------------------------------------------------------------------
function mockFetchResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// beginAppRegistration
// ---------------------------------------------------------------------------
describe('beginAppRegistration', () => {
  it('返回 deviceCode、qrUrl(含 from=oc_onboard 和 tp=ob_cli_app)、userCode', async () => {
    // beginAppRegistration 内部先调 init(action='init')，再调 begin(action='begin')
    let callCount = 0;
    vi.stubGlobal('fetch', async (_url: string, _init: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        // init 响应
        return mockFetchResponse({
          nonce: 'abc123',
          supported_auth_methods: ['client_secret'],
        });
      }
      // begin 响应
      return mockFetchResponse({
        device_code: 'dc_test_001',
        verification_uri: 'https://accounts.feishu.cn/qr',
        verification_uri_complete: 'https://accounts.feishu.cn/qr?code=abc',
        user_code: 'UC-001',
        interval: 5,
        expire_in: 300,
      });
    });

    const result = await beginAppRegistration('feishu');

    expect(result.deviceCode).toBe('dc_test_001');
    expect(result.userCode).toBe('UC-001');
    expect(result.interval).toBe(5);
    expect(result.expireIn).toBe(300);

    // qrUrl 必须含 from=oc_onboard 和 tp=ob_cli_app
    const qr = new URL(result.qrUrl);
    expect(qr.searchParams.get('from')).toBe('oc_onboard');
    expect(qr.searchParams.get('tp')).toBe('ob_cli_app');

    // 原始 code 参数也应保留
    expect(qr.searchParams.get('code')).toBe('abc');
  });

  it('使用默认 feishu 域名，向 accounts.feishu.cn 发请求', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, _init: RequestInit) => {
      urls.push(url);
      if (urls.length === 1) {
        return mockFetchResponse({
          nonce: 'n',
          supported_auth_methods: ['client_secret'],
        });
      }
      return mockFetchResponse({
        device_code: 'dc_x',
        verification_uri: 'https://accounts.feishu.cn/qr',
        verification_uri_complete: 'https://accounts.feishu.cn/qr',
        user_code: 'UC-X',
        interval: 3,
        expire_in: 120,
      });
    });

    await beginAppRegistration();
    expect(urls.every(u => u.includes('accounts.feishu.cn'))).toBe(true);
  });

  it('使用 lark 域名时，向 accounts.larksuite.com 发请求', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, _init: RequestInit) => {
      urls.push(url);
      if (urls.length === 1) {
        return mockFetchResponse({
          nonce: 'n',
          supported_auth_methods: ['client_secret'],
        });
      }
      return mockFetchResponse({
        device_code: 'dc_lark',
        verification_uri: 'https://accounts.larksuite.com/qr',
        verification_uri_complete: 'https://accounts.larksuite.com/qr',
        user_code: 'UC-LARK',
        interval: 5,
        expire_in: 600,
      });
    });

    await beginAppRegistration('lark');
    expect(urls.every(u => u.includes('accounts.larksuite.com'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pollAppRegistration
// ---------------------------------------------------------------------------
describe('pollAppRegistration', () => {
  it('先 authorization_pending，再 success → 返回 status:success + appId/appSecret', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', async (_url: string, _init: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        // 第一次: 还在等待
        return mockFetchResponse({ error: 'authorization_pending' }, 400);
      }
      // 第二次: 授权成功
      return mockFetchResponse({
        client_id: 'cli_test_app_id',
        client_secret: 'sec_test_secret',
        user_info: { open_id: 'ou_abcdef', tenant_brand: 'feishu' },
      });
    });

    const outcome = await pollAppRegistration({
      deviceCode: 'dc_test_001',
      interval: 0,       // interval:0 避免 sleep
      expireIn: 60,
    });

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.result.appId).toBe('cli_test_app_id');
      expect(outcome.result.appSecret).toBe('sec_test_secret');
      expect(outcome.result.ownerOpenId).toBe('ou_abcdef');
      expect(outcome.result.domain).toBe('feishu');
    }
  });

  it('返回 access_denied → status:access_denied', async () => {
    vi.stubGlobal('fetch', async () =>
      mockFetchResponse({ error: 'access_denied' }, 400),
    );

    const outcome = await pollAppRegistration({
      deviceCode: 'dc_deny',
      interval: 0,
      expireIn: 10,
    });
    expect(outcome.status).toBe('access_denied');
  });

  it('返回 expired_token → status:expired', async () => {
    vi.stubGlobal('fetch', async () =>
      mockFetchResponse({ error: 'expired_token' }, 400),
    );

    const outcome = await pollAppRegistration({
      deviceCode: 'dc_exp',
      interval: 0,
      expireIn: 10,
    });
    expect(outcome.status).toBe('expired');
  });

  it('返回未知 error → status:error + message 含 error 字段', async () => {
    vi.stubGlobal('fetch', async () =>
      mockFetchResponse({
        error: 'server_error',
        error_description: 'internal error',
      }, 500),
    );

    const outcome = await pollAppRegistration({
      deviceCode: 'dc_err',
      interval: 0,
      expireIn: 10,
    });
    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') {
      expect(outcome.message).toContain('server_error');
    }
  });

  it('expireIn:0 时立即 timeout', async () => {
    vi.stubGlobal('fetch', async () =>
      mockFetchResponse({ error: 'authorization_pending' }, 400),
    );

    const outcome = await pollAppRegistration({
      deviceCode: 'dc_timeout',
      interval: 0,
      expireIn: 0,
    });
    expect(outcome.status).toBe('timeout');
  });

  it('abortSignal 已触发时立即返回 timeout', async () => {
    const controller = new AbortController();
    controller.abort();

    vi.stubGlobal('fetch', async () =>
      mockFetchResponse({ error: 'authorization_pending' }, 400),
    );

    const outcome = await pollAppRegistration({
      deviceCode: 'dc_abort',
      interval: 0,
      expireIn: 60,
      abortSignal: controller.signal,
    });
    expect(outcome.status).toBe('timeout');
  });

  it('检测到 tenant_brand=lark 时自动切换域并继续轮询', async () => {
    const urls: string[] = [];
    let callCount = 0;
    vi.stubGlobal('fetch', async (url: string, _init: RequestInit) => {
      urls.push(url);
      callCount++;
      if (callCount === 1) {
        // feishu 域，返回 lark brand → 触发域切换
        return mockFetchResponse({
          user_info: { tenant_brand: 'lark' },
        });
      }
      // lark 域 → 返回成功
      return mockFetchResponse({
        client_id: 'cli_lark_id',
        client_secret: 'sec_lark_secret',
        user_info: { open_id: 'ou_lark', tenant_brand: 'lark' },
      });
    });

    const outcome = await pollAppRegistration({
      deviceCode: 'dc_lark',
      interval: 0,
      expireIn: 60,
      initialDomain: 'feishu',
    });

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.result.domain).toBe('lark');
    }
    // 第一次请求打到 feishu，第二次切到 lark
    expect(urls[0]).toContain('accounts.feishu.cn');
    expect(urls[1]).toContain('accounts.larksuite.com');
  });
});

// ---------------------------------------------------------------------------
// getAppOwnerOpenId
// ---------------------------------------------------------------------------
describe('getAppOwnerOpenId', () => {
  it('成功返回 owner_id (owner_type=2)', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', async (_url: string, _init: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        // tenant_access_token 响应
        return mockFetchResponse({ code: 0, tenant_access_token: 'tok_xyz' });
      }
      // app 信息响应
      return mockFetchResponse({
        code: 0,
        data: {
          app: {
            owner: { owner_id: 'ou_owner_001', owner_type: 2 },
            creator_id: 'ou_creator_001',
          },
        },
      });
    });

    const openId = await getAppOwnerOpenId({
      appId: 'cli_abc',
      appSecret: 'sec_abc',
      domain: 'feishu',
    });
    expect(openId).toBe('ou_owner_001');
  });

  it('owner_type 非 2 时回退到 creator_id', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', async () => {
      callCount++;
      if (callCount === 1) {
        return mockFetchResponse({ code: 0, tenant_access_token: 'tok_xyz' });
      }
      return mockFetchResponse({
        code: 0,
        data: {
          app: {
            owner: { owner_id: 'ou_owner_org', owner_type: 1 },
            creator_id: 'ou_creator_999',
          },
        },
      });
    });

    const openId = await getAppOwnerOpenId({ appId: 'cli_x', appSecret: 'sec_x' });
    expect(openId).toBe('ou_creator_999');
  });

  it('获取 token 失败时返回 undefined (fail-open)', async () => {
    vi.stubGlobal('fetch', async () =>
      mockFetchResponse({ code: 1, tenant_access_token: undefined }),
    );

    const openId = await getAppOwnerOpenId({ appId: 'cli_fail', appSecret: 'sec_fail' });
    expect(openId).toBeUndefined();
  });

  it('lark 域名时向 open.larksuite.com 发请求', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      return mockFetchResponse({ code: 0, tenant_access_token: 'tok_lark' });
    });

    await getAppOwnerOpenId({ appId: 'cli_lk', appSecret: 'sec_lk', domain: 'lark' });
    expect(urls[0]).toContain('open.larksuite.com');
  });
});
