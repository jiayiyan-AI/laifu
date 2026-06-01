/**
 * iLink HTTP 客户端 —— Tencent 官方 AI bot 框架 (ilinkai.weixin.qq.com)。
 *
 * 三类调用:
 *   1. 无 auth: get_bot_qrcode / get_qrcode_status (扫码登录前没 token)
 *   2. 已 auth (bot_token): getupdates / sendmessage / ...
 *
 * 镜像 mitsein providers/weixin/api_client.py + qr_login.py 但只做 text MVP。
 *
 * 长轮询语义: server 持有连接 ~35s,期间无新消息也返回 (errcode=0, msgs=[])。
 * 客户端 timeout 给 ~40s buffer。客户端 timeout 不算 error,降级返 wait 让上游 retry。
 */
import { randomBytes } from 'node:crypto';

export const ILINK_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const APP_VERSION = '1.0.0';
const APP_CLIENT_VERSION = buildClientVersion(APP_VERSION);     // 1.0.0 → 0x010000 = 65536
const POLL_CLIENT_TIMEOUT_MS = 40_000;                          // server 35s + 5s buffer
const QR_TIMEOUT_MS = 15_000;
const BOT_TYPE = 3;

function buildClientVersion(version: string): number {
  const [maj = '0', min = '0', patch = '0'] = version.split('.');
  return ((+maj & 0xff) << 16) | ((+min & 0xff) << 8) | (+patch & 0xff);
}

function randomUinHeader(): string {
  // 4 字节 uint32,base64 编码。iLink 协议头要求,内容只要每次随机即可。
  return randomBytes(4).toString('base64');
}

function generateClientId(): string {
  // sendmessage 用于 iLink 侧幂等去重;同一 client_id 不会被发两次。
  return `laifu:${Date.now()}-${randomBytes(4).toString('hex')}`;
}

function unauthedHeaders(): Record<string, string> {
  return {
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': String(APP_CLIENT_VERSION),
  };
}

function authedHeaders(botToken: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'Authorization': `Bearer ${botToken}`,
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': String(APP_CLIENT_VERSION),
    'X-WECHAT-UIN': randomUinHeader(),
  };
}

const BASE_INFO = { channel_version: '1.0.0' };

// ===== QR 阶段 =====

export interface QrStartResponse {
  qrcode: string;        // session_key,后续轮询用
  qr_url: string;        // 微信 App 扫的图片 URL
}

export const getBotQrcode = async (
  baseUrl: string = ILINK_DEFAULT_BASE_URL,
): Promise<QrStartResponse> => {
  const url = `${baseUrl}/ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: unauthedHeaders(),
    signal: AbortSignal.timeout(QR_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`get_bot_qrcode failed: ${resp.status}`);
  const data = await resp.json() as { qrcode?: string; qrcode_img_content?: string };
  return {
    qrcode: data.qrcode ?? '',
    qr_url: data.qrcode_img_content ?? '',
  };
};

export type QrPollResponse =
  | { status: 'wait' | 'scaned' | 'expired' }
  | { status: 'confirmed'; bot_token: string; ilink_bot_id: string; base_url: string }
  | { status: 'scaned_but_redirect'; redirect_host: string };

export const pollQrcodeStatus = async (
  qrcode: string,
  baseUrl: string = ILINK_DEFAULT_BASE_URL,
): Promise<QrPollResponse> => {
  const url = `${baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  let data: any;
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: unauthedHeaders(),
      // 长轮询: iLink server 挂 ~35s。client 给 40s buffer。
      signal: AbortSignal.timeout(POLL_CLIENT_TIMEOUT_MS),
    });
    if (!resp.ok) {
      // 短抖动 → 让上游 retry,不是 wait 是 unknown 也按 wait 处理
      return { status: 'wait' };
    }
    data = await resp.json();
  } catch {
    // client timeout 或网络故障 → 优雅降级让上游 retry
    return { status: 'wait' };
  }

  const status = data?.status ?? '';
  if (status === 'confirmed') {
    return {
      status: 'confirmed',
      bot_token: data.bot_token ?? '',
      ilink_bot_id: data.ilink_bot_id ?? '',
      base_url: data.baseurl ?? baseUrl,
    };
  }
  if (status === 'scaned_but_redirect') {
    return { status: 'scaned_but_redirect', redirect_host: data.redirect_host ?? '' };
  }
  if (status === 'scaned' || status === 'expired' || status === 'wait') {
    return { status };
  }
  // 未知状态降级 wait 让上游继续轮询
  return { status: 'wait' };
};

// ===== 已 auth =====

export interface GetUpdatesResponse {
  errcode: number;                  // 0=正常 / -14=session 失效 / ...
  msgs: any[];                      // raw 消息列表,inbound.ts 负责解析
  get_updates_buf: string;
}

export interface IlinkClient {
  getUpdates(
    cursor: string | null,
    opts: { timeoutMs: number; signal: AbortSignal },
  ): Promise<GetUpdatesResponse>;
  sendText(args: {
    to_user_id: string;
    text: string;
    context_token: string;
  }): Promise<void>;
}

export const makeIlinkClient = (opts: { botToken: string; baseUrl: string }): IlinkClient => {
  const baseUrl = opts.baseUrl.replace(/\/$/, '');

  const post = async <T>(endpoint: string, body: unknown, fetchOpts: { signal?: AbortSignal } = {}): Promise<T> => {
    const resp = await fetch(`${baseUrl}/${endpoint}`, {
      method: 'POST',
      headers: authedHeaders(opts.botToken),
      body: JSON.stringify(body),
      signal: fetchOpts.signal,
    });
    if (!resp.ok) throw new Error(`${endpoint} failed: ${resp.status}`);
    // 部分端点可能返回空 body (sendmessage)
    const text = await resp.text();
    return text ? JSON.parse(text) as T : ({} as T);
  };

  return {
    async getUpdates(cursor, { timeoutMs, signal }) {
      // 合并外部 abort signal 跟 timeout signal
      const composite = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      return post<GetUpdatesResponse>('ilink/bot/getupdates', {
        get_updates_buf: cursor ?? '',
        base_info: BASE_INFO,
      }, { signal: composite });
    },

    async sendText({ to_user_id, text, context_token }) {
      const msg: Record<string, unknown> = {
        from_user_id: '',
        to_user_id,
        client_id: generateClientId(),
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text } }],
      };
      if (context_token) msg.context_token = context_token;
      await post<void>('ilink/bot/sendmessage', {
        msg,
        base_info: BASE_INFO,
      });
    },
  };
};
