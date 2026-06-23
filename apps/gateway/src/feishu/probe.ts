/**
 * feishu/probe.ts — 验活探针
 *
 * 从 openclaw/extensions/feishu/src/probe.ts 移植，去除:
 *   - openclaw/plugin-sdk/* 依赖 → formatErrorMessage 内联
 *   - BaseProbeResult 类型 → 内联 FeishuProbeResult
 *   - 64 条 LRU 缓存逻辑 → activate 只调一次，不需要缓存
 *
 * 保留:
 *   - 端点 POST /open-apis/bot/v1/openclaw_bot/ping（搭便车关键）
 *   - body { needBotInfo: true }
 *   - bot open_id 取自 data.pingBotInfo.botID
 */

import { raceWithTimeoutAndAbort } from './async.js';
import { createFeishuClient } from './client.js';

const fmtErr = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const FEISHU_PROBE_REQUEST_TIMEOUT_MS = 10_000;

export interface FeishuProbeResult {
  ok: boolean;
  botOpenId?: string;
  botName?: string;
  error?: string;
}

type FeishuPingResponse = {
  code: number;
  msg?: string;
  data?: { pingBotInfo?: { botID?: string; botName?: string } };
};

export async function probeFeishu(creds: {
  appId: string;
  appSecret: string;
  domain: 'feishu' | 'lark';
}): Promise<FeishuProbeResult> {
  if (!creds.appId || !creds.appSecret) {
    return { ok: false, error: 'missing credentials (appId, appSecret)' };
  }

  const timeoutMs = FEISHU_PROBE_REQUEST_TIMEOUT_MS;

  try {
    const client = createFeishuClient(creds);

    const responseResult = await raceWithTimeoutAndAbort<FeishuPingResponse>(
      (client as unknown as {
        request(params: {
          method: 'POST';
          url: string;
          data: Record<string, unknown>;
          timeout: number;
        }): Promise<FeishuPingResponse>;
      }).request({
        method: 'POST',
        url: '/open-apis/bot/v1/openclaw_bot/ping',
        data: { needBotInfo: true },
        timeout: timeoutMs,
      }),
      { timeoutMs },
    );

    if (responseResult.status === 'aborted') {
      return { ok: false, error: 'probe aborted' };
    }
    if (responseResult.status === 'timeout') {
      return { ok: false, error: `probe timed out after ${timeoutMs}ms` };
    }

    const response = responseResult.value;

    if (response.code !== 0) {
      return {
        ok: false,
        error: `API error: ${response.msg || `code ${response.code}`}`,
      };
    }

    const botInfo = response.data?.pingBotInfo;
    return {
      ok: true,
      botOpenId: botInfo?.botID,
      botName: botInfo?.botName,
    };
  } catch (err) {
    return { ok: false, error: fmtErr(err) };
  }
}
