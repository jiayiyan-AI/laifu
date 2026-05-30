import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config.js';

let _client: SupabaseClient | null = null;

export const getSupabase = (): SupabaseClient => {
  if (!_client) {
    if (!config.supabase.url || !config.supabase.serviceRoleKey) {
      throw new Error('Supabase config missing (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
    }
    _client = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
      auth: { persistSession: false },
    });
  }
  return _client;
};

// 单元测试用
export const _resetSupabase = () => {
  _client = null;
};
