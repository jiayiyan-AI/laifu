// === Container HTTP 契约 (Gateway → Container) ===
// 沿用同事 Hermes Container (docker/hermes/server.py) 的同步 /chat 契约

export interface ContainerChatRequest {
  message: string;
  session_id: string;          // e.g. "web:thr_abc123" / "wechat:main"
  source: 'web' | 'wechat';
}

export interface ContainerChatResponse {
  reply: string;
  session_id: string;
  exit_code: number;
}

export interface ContainerHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  ts: number;                  // unix epoch (seconds, float)
}

export interface ContainerHistoryResponse {
  messages: ContainerHistoryMessage[];
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

// === Web chat 契约（浏览器 ↔ Gateway,同步）===

export interface WebChatRequest {
  thread_id: string;
  message: string;
}

export interface WebChatResponse {
  reply: string;
}

// 历史消息(浏览器从 gateway 拉);形状跟 ContainerHistoryMessage 一致,
// 单独起名是为了 Web 端可以单方向加字段(比如本地的 pending 标记)
export type ThreadMessage = ContainerHistoryMessage;

export interface WebThreadMessagesResponse {
  messages: ThreadMessage[];
}
