import type {
  AuthMeResponse,
  CloudListResponse,
  CloudUploadResponse,
  EntitlementChangeResponse,
  MessageRow,
  AgentLoopRow,
  PasswordLoginRequest,
  PasswordRegisterRequest,
  PurchaseRequest,
  PurchaseResponse,
  StatusResponse,
  ThreadCreateRequest,
  ThreadCreateResponse,
  ThreadListItem,
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

export class QuotaError extends Error {
  used_cny_month: number;
  free_quota_cny_month: number;
  balance_cny: number;
  constructor(body: { used_cny_month?: number; free_quota_cny_month?: number; balance_cny?: number }) {
    super('quota exhausted');
    this.name = 'QuotaError';
    this.used_cny_month = body.used_cny_month ?? 0;
    this.free_quota_cny_month = body.free_quota_cny_month ?? 0;
    this.balance_cny = body.balance_cny ?? 0;
  }
}

export class BusyError extends Error {
  constructor(message: string) {
    super(message || '正在处理上一条消息，请稍候。');
    this.name = 'BusyError';
  }
}

const json = async <T>(path: string, opts: RequestInit = {}): Promise<T> => {
  const resp = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
    ...opts,
  });
  if (resp.status === 401) throw new AuthError();
  if (resp.status === 402) {
    const body = await resp.json().catch(() => ({}));
    throw new QuotaError(body);
  }
  if (resp.status === 409) {
    const body = await resp.json().catch(() => ({}));
    throw new BusyError((body as { message?: string }).message ?? '');
  }
  if (!resp.ok) throw new Error(`${path} → ${resp.status}`);
  return resp.json() as Promise<T>;
};

// === Auth ===
export const me = (): Promise<AuthMeResponse> => json('/api/auth/me');

/**
 * 表单提交类接口的错误: 携带后端稳定 code (AuthErrorCode / PurchaseErrorCode 等),
 * 让调用方给精确文案。不复用通用 json(): 它把 409 一律当 BusyError("正在处理上一条消息"),
 * 对注册 / 购买语义是错的。
 */
export class ApiError extends Error {
  code: string;
  status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const submitJson = async <T>(path: string, body: unknown): Promise<T> => {
  const resp = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (resp.ok) return resp.json() as Promise<T>;
  const b = (await resp.json().catch(() => ({}))) as { error?: string; code?: string };
  throw new ApiError(resp.status, b.code ?? 'unknown', b.error ?? `${path} → ${resp.status}`);
};

export const login = (body: PasswordLoginRequest): Promise<AuthMeResponse> =>
  submitJson('/api/auth/password/login', body);

export const register = (body: PasswordRegisterRequest): Promise<AuthMeResponse> =>
  submitJson('/api/auth/password/register', body);

export const logout = (): Promise<{ ok: true }> =>
  json('/api/auth/logout', { method: 'POST' });

// === Purchase / Status ===
export const purchase = (body: PurchaseRequest): Promise<PurchaseResponse> =>
  submitJson('/api/purchase', body);

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

export const fetchHistory = async (threadId: string): Promise<MessageRow[]> => {
  const { messages } = await json<WebThreadMessagesResponse>(
    `/api/threads/${encodeURIComponent(threadId)}/messages`,
  );
  return messages;
};

export const fetchActiveLoop = async (threadId: string): Promise<AgentLoopRow | null> => {
  const { loop } = await json<{ loop: AgentLoopRow | null }>(
    `/api/threads/${encodeURIComponent(threadId)}/loop`,
  );
  return loop;
};

// === Loop SSE 订阅 ===

export interface LoopStreamCallbacks {
  onHeartbeat: () => void;
  onDone: (reply: string) => void;
  onFail: (error: string) => void;
}

/**
 * 连接 per-loop SSE，接收心跳和最终结果。
 * 返回 cleanup 函数用于关闭连接。
 */
export function connectLoopStream(loopId: string, callbacks: LoopStreamCallbacks): () => void {
  const es = new EventSource(
    `/api/loops/${encodeURIComponent(loopId)}/stream`,
    { withCredentials: true },
  );
  es.addEventListener('heartbeat', () => callbacks.onHeartbeat());
  es.addEventListener('done', (e: MessageEvent) => {
    const d = JSON.parse(e.data);
    callbacks.onDone(d.reply ?? '');
    es.close();
  });
  es.addEventListener('fail', (e: MessageEvent) => {
    const d = JSON.parse(e.data);
    callbacks.onFail(d.error ?? '处理失败');
    es.close();
  });
  es.onerror = () => {
    // EventSource 自动重连; gateway 侧 loop 已完成时会立即返回终态事件
  };
  return () => es.close();
}

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

// === Cloud Drive (P4+P5) ===

// 通用能力开关
export const enableFeature = (feature: string): Promise<EntitlementChangeResponse> =>
  json(`/api/entitlements/${encodeURIComponent(feature)}/enable`, { method: 'POST' });

export const disableFeature = (feature: string): Promise<EntitlementChangeResponse> =>
  json(`/api/entitlements/${encodeURIComponent(feature)}/disable`, { method: 'POST' });

export const cloudList = (prefix = ''): Promise<CloudListResponse> => {
  const q = prefix ? `?prefix=${encodeURIComponent(prefix)}` : '';
  return json(`/api/cloud/list${q}`);
};

/**
 * 构造下载 URL（不发请求）。前端用 `window.open(url)` 让浏览器跟 302 走到 Blob。
 *  dispose='inline' (默认): SAS 不带 rscd，浏览器按 content-type 决定显示/下载
 *  dispose='attachment': SAS 带 rscd，强制下载并用 metadata.title 当文件名
 */
export const cloudDownloadUrl = (path: string, dispose: 'inline' | 'attachment' = 'inline'): string => {
  const params = new URLSearchParams({ path });
  if (dispose === 'attachment') params.set('dispose', 'attachment');
  return `/api/cloud/download?${params.toString()}`;
};

export interface CloudUploadOpts {
  title?: string;
  onProgress?: (fraction: number) => void;  // 0..1
}

/**
 * 上传文件到云盘（multipart 走 gateway 代理）。
 * 用 XMLHttpRequest 以拿到上传进度（fetch 不支持 upload progress）。
 */
export const cloudUpload = (
  file: File,
  virtualPath: string,
  opts: CloudUploadOpts = {},
): Promise<CloudUploadResponse> => {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file);
    form.append('virtual_path', virtualPath);
    if (opts.title) form.append('title', opts.title);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/cloud/upload');
    xhr.withCredentials = true;
    if (opts.onProgress) {
      xhr.upload.onprogress = (e: ProgressEvent) => {
        if (e.lengthComputable) opts.onProgress!(e.loaded / e.total);
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText) as CloudUploadResponse); }
        catch { reject(new Error('invalid upload response')); }
      } else {
        let msg = `upload → ${xhr.status}`;
        try { const b = JSON.parse(xhr.responseText); if (b?.error) msg = `${xhr.status}: ${b.error}`; } catch { /* ignore */ }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error('upload network error'));
    xhr.send(form);
  });
};
