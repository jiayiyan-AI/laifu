// === Container HTTP 契约 (Gateway → Container) ===

export interface ChatStartRequest {
  session_id: string;          // e.g. "web:thr_abc123" or "wechat:main"
  message: string;
  source: 'web' | 'wechat';
}

export interface ChatStartResponse {
  stream_id: string;
}

// SSE event payloads
export interface SSEEventToken {
  text: string;
}

export interface SSEEventTool {
  name: string;
  preview: string;
}

export interface SSEEventDone {
  full_reply: string;
  session_id: string;
}

export interface SSEEventError {
  message: string;
  trace?: string;
}

// === Gateway Web API 契约 (Web → Gateway) ===

export interface PurchaseRequest {
  // 当前无 body 字段；MVP 全免费、单套餐
}

export interface PurchaseResponse {
  user_id: string;
  status: 'provisioning' | 'ready' | 'failed';
}

export interface StatusResponse {
  status: 'provisioning' | 'ready' | 'failed';
  provisioning_step: string | null;
  progress_pct: number;
  error_message: string | null;
}

// === Auth 契约 ===

export interface DevLoginRequest {
  wx_unionid: string;        // 模拟一个 unionid（dev 模式跳过真实微信扫码）
  nickname?: string;
}

export interface AuthMeResponse {
  user_id: string;
  wx_unionid: string;
  nickname: string | null;
  avatar_url: string | null;
}

// === Threads 契约 ===

export interface ThreadCreateRequest {
  title?: string;            // 可选；后端会用首条消息补
}

export interface ThreadCreateResponse {
  id: string;                // e.g. "thr_abc123"
  user_id: string;
  source: 'web';
  title: string | null;
  created_at: string;
  updated_at: string;
  archived: boolean;
}

export interface ThreadListItem {
  id: string;
  title: string | null;
  updated_at: string;
  archived: boolean;
}

// === Web chat 契约（浏览器 ↔ Gateway）===

export interface WebChatStartRequest {
  thread_id: string;
  message: string;
}

export interface WebChatStartResponse {
  stream_id: string;         // outer stream_id（不暴露 container 的内层 ID）
}
