import type {
  AuthMeResponse,
  PurchaseResponse,
  StatusResponse,
  ThreadCreateRequest,
  ThreadCreateResponse,
  ThreadListItem,
  ThreadMessage,
  WebChatRequest,
  WebChatResponse,
  WebThreadMessagesResponse,
  WechatQrStartResponse,
  WechatQrPollRequest,
  WechatQrPollResponse,
  WechatBindingInfoResponse,
  WechatUnbindResponse,
} from '@lingxi/shared';

export class AuthError extends Error {
  constructor() {
    super('not authenticated');
    this.name = 'AuthError';
  }
}

const json = async <T>(path: string, opts: RequestInit = {}): Promise<T> => {
  const resp = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
    ...opts,
  });
  if (resp.status === 401) throw new AuthError();
  if (!resp.ok) throw new Error(`${path} → ${resp.status}`);
  return resp.json() as Promise<T>;
};

// === Auth ===
export const me = (): Promise<AuthMeResponse> => json('/api/auth/me');

export const logout = (): Promise<{ ok: true }> =>
  json('/api/auth/logout', { method: 'POST' });

// === Purchase / Status ===
export const purchase = (): Promise<PurchaseResponse> =>
  json('/api/purchase', { method: 'POST' });

export const status = async (): Promise<StatusResponse | null> => {
  const resp = await fetch('/api/status', { credentials: 'include' });
  if (resp.status === 401) throw new AuthError();
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`/api/status → ${resp.status}`);
  return resp.json() as Promise<StatusResponse>;
};

// === Threads ===
export const listThreads = async (): Promise<ThreadListItem[]> => {
  const { threads } = await json<{ threads: ThreadListItem[] }>('/api/threads');
  return threads;
};

export const createThread = (body: ThreadCreateRequest): Promise<ThreadCreateResponse> =>
  json('/api/threads', { method: 'POST', body: JSON.stringify(body) });

export const deleteThread = (id: string): Promise<{ ok: true }> =>
  json(`/api/threads/${encodeURIComponent(id)}`, { method: 'DELETE' });

// === Chat ===
export const sendChat = (body: WebChatRequest): Promise<WebChatResponse> =>
  json('/api/chat', { method: 'POST', body: JSON.stringify(body) });

export const fetchHistory = async (threadId: string): Promise<ThreadMessage[]> => {
  const { messages } = await json<WebThreadMessagesResponse>(
    `/api/threads/${encodeURIComponent(threadId)}/messages`,
  );
  return messages;
};

// === WeChat iLink 扫码绑定 ===
export const startWechatBind = (): Promise<WechatQrStartResponse> =>
  json('/api/wechat/bind/qr-start', { method: 'POST' });

export const pollWechatBind = (qrcode: string): Promise<WechatQrPollResponse> => {
  const body: WechatQrPollRequest = { qrcode };
  return json('/api/wechat/bind/qr-poll', { method: 'POST', body: JSON.stringify(body) });
};

export const getMyWechatBind = (): Promise<WechatBindingInfoResponse> =>
  json('/api/wechat/bind');

export const unbindWechat = (): Promise<WechatUnbindResponse> =>
  json('/api/wechat/bind', { method: 'DELETE' });
