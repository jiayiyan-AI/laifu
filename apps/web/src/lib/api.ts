import type {
  AuthMeResponse,
  DevLoginRequest,
  PurchaseResponse,
  StatusResponse,
  ThreadCreateRequest,
  ThreadCreateResponse,
  ThreadListItem,
  WebChatStartRequest,
  WebChatStartResponse,
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
export const devLogin = (body: DevLoginRequest): Promise<AuthMeResponse> =>
  json('/api/auth/dev/login', { method: 'POST', body: JSON.stringify(body) });

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
export const startChat = (body: WebChatStartRequest): Promise<WebChatStartResponse> =>
  json('/api/chat/start', { method: 'POST', body: JSON.stringify(body) });
