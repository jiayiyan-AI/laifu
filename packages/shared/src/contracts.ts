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
