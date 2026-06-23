// DB row types — 与 packages/db/src/schema.ts 对齐 (历史: 早期对应 infra/supabase/migrations/*, 现已迁到 Drizzle)

export type ContainerStatus = 'provisioning' | 'ready' | 'failed';
export type MessageSource = 'web' | 'wechat';

export interface User {
  id: string;                  // uuid
  provider: string;            // 'google' | 'dev' | 'github' | ...
  external_id: string;         // provider 内稳定 ID
  email: string | null;
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
  policy_hash: string | null;   // ACA 当前已应用的 POLICY_HASH; NULL = 从未 reconcile
  assistant_name: string | null;  // 用户给助理起的名字（购买时写入）; 存量行为 NULL
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
