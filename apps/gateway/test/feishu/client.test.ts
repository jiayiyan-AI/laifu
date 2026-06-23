/**
 * Tests for feishu/client.ts — Lark SDK 封装
 *
 * createFeishuClient / createFeishuWSClient: 至少测"不抛、返回对象"
 * sendFeishuMessage: 注入假 client，断言 im.message.create 收到正确参数
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- mock @larksuiteoapi/node-sdk ----------------------------------------
// vi.mock 会被 hoisted，factory 内不能引用文件顶层变量。
// 用 vi.hoisted 把构造函数提前初始化。
const { MockClient, MockWSClient } = vi.hoisted(() => {
  // vi.fn() needs to be used with `new` — use class syntax so it's a proper constructor
  class MockClientClass {
    __isMockClient = true;
  }
  class MockWSClientClass {
    __isMockWSClient = true;
  }
  return {
    MockClient: vi.fn(function (this: MockClientClass, _params: unknown) {}) as unknown as {
      new (params: unknown): { __isMockClient?: boolean };
      mock: { calls: unknown[][] };
      mockClear: () => void;
    } & ReturnType<typeof vi.fn>,
    MockWSClient: vi.fn(function (this: MockWSClientClass, _params: unknown) {}) as unknown as {
      new (params: unknown): { __isMockWSClient?: boolean };
      mock: { calls: unknown[][] };
      mockClear: () => void;
    } & ReturnType<typeof vi.fn>,
  };
});

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: MockClient,
  WSClient: MockWSClient,
  AppType: { SelfBuild: 0, ISV: 1 },
  Domain: { Feishu: 0, Lark: 1 },
  LoggerLevel: { fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 },
  // UA 拦截器代码会读 defaultHttpInstance.interceptors，给一个空对象即可
  defaultHttpInstance: { interceptors: undefined },
}));

// ---- 被测模块（mock 就绪后再 import）--------------------------------------
import {
  createFeishuClient,
  createFeishuWSClient,
  sendFeishuMessage,
} from '../../src/feishu/client.js';

// ---------------------------------------------------------------------------
// createFeishuClient
// ---------------------------------------------------------------------------
describe('createFeishuClient', () => {
  beforeEach(() => {
    MockClient.mockClear();
  });

  it('不抛、返回对象', () => {
    const result = createFeishuClient({ appId: 'app_id', appSecret: 'app_secret', domain: 'feishu' });
    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
  });

  it('使用 AppType.SelfBuild 构造 Client', () => {
    createFeishuClient({ appId: 'id1', appSecret: 'sec1', domain: 'feishu' });
    expect(MockClient).toHaveBeenCalledWith(
      expect.objectContaining({ appType: 0 /* AppType.SelfBuild */ }),
    );
  });

  it('domain=feishu 时 domain 参数为 Domain.Feishu(0)', () => {
    createFeishuClient({ appId: 'id2', appSecret: 'sec2', domain: 'feishu' });
    expect(MockClient).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 0 /* Domain.Feishu */ }),
    );
  });

  it('domain=lark 时 domain 参数为 Domain.Lark(1)', () => {
    createFeishuClient({ appId: 'id3', appSecret: 'sec3', domain: 'lark' });
    expect(MockClient).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 1 /* Domain.Lark */ }),
    );
  });
});

// ---------------------------------------------------------------------------
// createFeishuWSClient
// ---------------------------------------------------------------------------
describe('createFeishuWSClient', () => {
  beforeEach(() => {
    MockWSClient.mockClear();
  });

  it('不抛、返回对象', () => {
    const result = createFeishuWSClient({ appId: 'ws_id', appSecret: 'ws_sec', domain: 'feishu' });
    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
  });

  it('domain=lark 时 domain 参数为 Domain.Lark(1)', () => {
    createFeishuWSClient({ appId: 'ws_id2', appSecret: 'ws_sec2', domain: 'lark' });
    expect(MockWSClient).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 1 /* Domain.Lark */ }),
    );
  });

  it('传入 loggerLevel', () => {
    createFeishuWSClient({ appId: 'ws_id3', appSecret: 'ws_sec3', domain: 'feishu' });
    expect(MockWSClient).toHaveBeenCalledWith(
      expect.objectContaining({ loggerLevel: expect.any(Number) }),
    );
  });
});

// ---------------------------------------------------------------------------
// sendFeishuMessage
// ---------------------------------------------------------------------------
describe('sendFeishuMessage', () => {
  it('调用 client.im.message.create 并传正确参数', async () => {
    const createFn = vi.fn().mockResolvedValue({ code: 0 });
    const fakeClient = {
      im: {
        message: {
          create: createFn,
        },
      },
    };

    await sendFeishuMessage(fakeClient as any, 'ou_target_user', 'hello world');

    expect(createFn).toHaveBeenCalledTimes(1);
    expect(createFn).toHaveBeenCalledWith({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: 'ou_target_user',
        msg_type: 'text',
        content: JSON.stringify({ text: 'hello world' }),
      },
    });
  });

  it('文本内容正确序列化到 content 字段', async () => {
    const createFn = vi.fn().mockResolvedValue({ code: 0 });
    const fakeClient = { im: { message: { create: createFn } } };

    const specialText = 'hello\n"world"';
    await sendFeishuMessage(fakeClient as any, 'ou_123', specialText);

    const call = createFn.mock.calls[0][0];
    expect(call.data.content).toBe(JSON.stringify({ text: specialText }));
  });

  it('create 抛出时 sendFeishuMessage 透传异常', async () => {
    const createFn = vi.fn().mockRejectedValue(new Error('network error'));
    const fakeClient = { im: { message: { create: createFn } } };

    await expect(
      sendFeishuMessage(fakeClient as any, 'ou_bad', 'test'),
    ).rejects.toThrow('network error');
  });
});
