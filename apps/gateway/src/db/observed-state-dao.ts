import type { SupabaseClient } from '@supabase/supabase-js';

export interface ObservedStateRow {
  user_id: string;
  observed_entitlements: string[];
  observed_token_version: number;
  reported_at?: string;
}

export interface ObservedStateDao {
  upsert(input: Omit<ObservedStateRow, 'reported_at'>): Promise<void>;
  get(userId: string): Promise<ObservedStateRow | null>;
}

export const makeObservedStateDao = (sb: SupabaseClient): ObservedStateDao => {
  return {
    async upsert(input) {
      const { error } = await sb.from('container_observed_state').upsert(
        {
          user_id: input.user_id,
          observed_entitlements: input.observed_entitlements,
          observed_token_version: input.observed_token_version,
          reported_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' },
      );
      if (error) throw new Error(`observed upsert: ${error.message}`);
    },

    async get(userId) {
      const { data, error } = await sb
        .from('container_observed_state')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw new Error(`observed get: ${error.message}`);
      return data as ObservedStateRow | null;
    },
  };
};
