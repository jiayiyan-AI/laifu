/**
 * 微信公众号(测试号)客户端 —— access_token 缓存 + 二维码工单 + webhook 签名校验。
 *
 * 微信 access_token TTL 默认 7200s,我们保守按 (TTL - 5min) 当作有效期上限。
 * 这样即便我们时钟跟微信差一点,也不会用着已经过期的 token 去调 qrcode/create
 * 撞 errcode=40001。
 *
 * verifyWebhookSignature 是纯函数: signature = sha1(sort([token, ts, nonce]).join(''))
 * 留这一道闸把微信以外的人挡在 /api/wechat/webhook 之外。
 */
import { createHash } from 'node:crypto';

const TOKEN_URL = 'https://api.weixin.qq.com/cgi-bin/token';
const QRCODE_URL = 'https://api.weixin.qq.com/cgi-bin/qrcode/create';
const SAFETY_BUFFER_MS = 5 * 60 * 1000;
const DEFAULT_QR_EXPIRE_SECONDS = 600;       // 10 分钟,跟绑定 ticket 同步

export interface MpClient {
  getAccessToken(): Promise<string>;
  createBindQrCode(sceneStr: string, expireSeconds?: number): Promise<{
    ticket: string;
    url: string;
    expire_seconds: number;
  }>;
}

interface CachedToken {
  token: string;
  expiresAt: number;       // ms epoch
}

interface WechatTokenResp { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string }
interface WechatQrCodeResp { ticket?: string; url?: string; expire_seconds?: number; errcode?: number; errmsg?: string }

export const makeMpClient = (opts: {
  appId: string;
  appSecret: string;
  now?: () => number;     // 可注入便于测试
}): MpClient => {
  const now = opts.now ?? Date.now;
  let cache: CachedToken | null = null;

  const getAccessToken = async (): Promise<string> => {
    if (cache && cache.expiresAt > now()) return cache.token;

    const url = `${TOKEN_URL}?grant_type=client_credential`
      + `&appid=${encodeURIComponent(opts.appId)}`
      + `&secret=${encodeURIComponent(opts.appSecret)}`;
    const resp = await fetch(url);
    const data = await resp.json() as WechatTokenResp;
    if (!data.access_token || !data.expires_in) {
      throw new Error(`wechat token endpoint error: errcode=${data.errcode} errmsg=${data.errmsg ?? 'unknown'}`);
    }
    cache = {
      token: data.access_token,
      expiresAt: now() + data.expires_in * 1000 - SAFETY_BUFFER_MS,
    };
    return data.access_token;
  };

  const createBindQrCode = async (sceneStr: string, expireSeconds = DEFAULT_QR_EXPIRE_SECONDS) => {
    const token = await getAccessToken();
    const resp = await fetch(`${QRCODE_URL}?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expire_seconds: expireSeconds,
        action_name: 'QR_STR_SCENE',
        action_info: { scene: { scene_str: sceneStr } },
      }),
    });
    const data = await resp.json() as WechatQrCodeResp;
    if (!data.ticket || !data.url || typeof data.expire_seconds !== 'number') {
      throw new Error(`wechat qrcode/create error: errcode=${data.errcode} errmsg=${data.errmsg ?? 'unknown'}`);
    }
    return { ticket: data.ticket, url: data.url, expire_seconds: data.expire_seconds };
  };

  return { getAccessToken, createBindQrCode };
};

export const verifyWebhookSignature = (
  signature: string,
  timestamp: string,
  nonce: string,
  token: string,
): boolean => {
  const sorted = [token, timestamp, nonce].sort().join('');
  const expected = createHash('sha1').update(sorted).digest('hex');
  return expected === signature;
};
