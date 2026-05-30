// DB row types — 与 infra/supabase/migrations/0001_init.sql 中表结构一一对应

export type ContainerStatus = 'provisioning' | 'ready' | 'failed';
export type MessageSource = 'web' | 'wechat';
export type WechatSessionStatus = 'active' | 'expired' | 'disabled';

export interface User {
  id: string;                  // uuid
  wx_unionid: string;
  nickname: string | null;
  avatar_url: string | null;
  created_at: string;
}

export interface ContainerMapping {
  user_id: string;
  container_name: string;
  container_url: string | null;
  status: ContainerStatus;
  provisioning_step: string | null;
  progress_pct: number;
  error_message: string | null;
  azure_files_share: string | null;
  created_at: string;
  ready_at: string | null;
}

export interface WechatSession {
  user_id: string;
  bot_token: string;
  expires_at: string;
  status: WechatSessionStatus;
  bound_wx_nick: string | null;
  updated_at: string;
}

export interface ContextToken {
  user_id: string;
  contact_id: string;
  token: string;
  updated_at: string;
}

export interface Thread {
  id: string;
  user_id: string;
  source: MessageSource;
  title: string | null;
  created_at: string;
  updated_at: string;
  archived: boolean;
}
