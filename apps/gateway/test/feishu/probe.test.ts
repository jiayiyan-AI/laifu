/**
 * Tests for feishu/probe.ts — 验活探针
 *
 * mock createFeishuClient，注入假 request，断言 probeFeishu 正确解析响应。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- mock @larksuiteoapi/node-sdk (client.ts 顶层会读 defaultHttpInstance) --
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: vi.fn(),
  WSClient: vi.fn(),
  AppType: { SelfBuild: 0, ISV: 1 },
  Domain: { Feishu: 0, Lark: 1 },
  LoggerLevel: { info: 3 },
  defaultHttpInstance: { interceptors: undefined },
}));

// ---- mock client.js -------------------------------------------------------
const mockRequest = vi.fn();

vi.mock('../../src/feishu/client.js', () => ({
  createFeishuClient: () => ({
    request: mockRequest,
  }),
}));

// ---- 被测模块（mock 就绪后再 import）--------------------------------------
import { probeFeishu } from '../../src/feishu/probe.js';

const CREDS = { appId: 'cli_test', appSecret: 'secret_test', domain: 'feishu' } as const;

// 飞书 ping 成功响应真实形状（以 probe.ts 源 data.pingBotInfo.botID 为准）
const SUCCESS_RESPONSE = {
  code: 0,
  msg: 'success',
  data: {
    pingBotInfo: {
      botID: 'ou_abc123def456',
      botName: '测试机器人',
    },
  },
};

describe('probeFeishu', () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  // -------------------------------------------------------------------------
  // 成功路径
  // -------------------------------------------------------------------------
  describe('成功 — code 0 + pingBotInfo', () => {
    it('返回 ok:true，botOpenId 取自 data.pingBotInfo.botID', async () => {
      mockRequest.mockResolvedValue(SUCCESS_RESPONSE);

      const result = await probeFeishu(CREDS);

      expect(result.ok).toBe(true);
      expect(result.botOpenId).toBe('ou_abc123def456');
      expect(result.botName).toBe('测试机器人');
      expect(result.error).toBeUndefined();
    });

    it('以 POST /open-apis/bot/v1/openclaw_bot/ping + needBotInfo:true 调用 request', async () => {
      mockRequest.mockResolvedValue(SUCCESS_RESPONSE);

      await probeFeishu(CREDS);

      expect(mockRequest).toHaveBeenCalledTimes(1);
      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          url: '/open-apis/bot/v1/openclaw_bot/ping',
          data: { needBotInfo: true },
        }),
      );
    });

    it('pingBotInfo 缺 botName 时 botName 为 undefined', async () => {
      mockRequest.mockResolvedValue({
        code: 0,
        data: { pingBotInfo: { botID: 'ou_nnn' } },
      });

      const result = await probeFeishu(CREDS);
      expect(result.ok).toBe(true);
      expect(result.botOpenId).toBe('ou_nnn');
      expect(result.botName).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // 失败路径
  // -------------------------------------------------------------------------
  describe('失败 — request reject', () => {
    it('request 抛出时返回 ok:false 且 error 含错误消息', async () => {
      mockRequest.mockRejectedValue(new Error('network timeout'));

      const result = await probeFeishu(CREDS);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('network timeout');
      expect(result.botOpenId).toBeUndefined();
    });

    it('非 Error 对象 reject 时 error 为字符串', async () => {
      mockRequest.mockRejectedValue('plain string error');

      const result = await probeFeishu(CREDS);

      expect(result.ok).toBe(false);
      expect(result.error).toBe('plain string error');
    });
  });

  describe('失败 — 飞书 API 返回非 0 code', () => {
    it('code !== 0 时返回 ok:false，error 含 msg', async () => {
      mockRequest.mockResolvedValue({ code: 10003, msg: 'app_not_found' });

      const result = await probeFeishu(CREDS);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('app_not_found');
    });

    it('code !== 0 且 msg 缺失时 error 含 code 数字', async () => {
      mockRequest.mockResolvedValue({ code: 99999 });

      const result = await probeFeishu(CREDS);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('99999');
    });
  });

  describe('失败 — 凭证缺失', () => {
    it('appId 为空时返回 ok:false', async () => {
      const result = await probeFeishu({ appId: '', appSecret: 'sec', domain: 'feishu' });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/missing credentials/);
    });

    it('appSecret 为空时返回 ok:false', async () => {
      const result = await probeFeishu({ appId: 'id', appSecret: '', domain: 'feishu' });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/missing credentials/);
    });
  });
});
