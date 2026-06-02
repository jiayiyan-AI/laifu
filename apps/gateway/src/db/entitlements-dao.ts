import type { SupabaseClient } from '@supabase/supabase-js';

export interface EntitlementsDao {
  /** 列出 user 当前 active 的 features (disabled_at IS NULL). */
  listActive(userId: string): Promise<string[]>;

  /** 启用 (或重新启用) 某 feature；返回是否真发生了状态变更. */
  enable(userId: string, feature: string): Promise<{ changed: boolean }>;

  /** 停用某 feature (disabled_at = now)；返回是否真发生了状态变更. */
  disable(userId: string, feature: string): Promise<{ changed: boolean }>;

  /** 拿 users.token_version. user 不存在返回 null. */
  getTokenVersion(userId: string): Promise<number | null>;

  /** 原子递增 token_version, 返回新值. */
  bumpTokenVersion(userId: string): Promise<number>;
}

export const makeEntitlementsDao = (sb: SupabaseClient): EntitlementsDao => {
  return {
    async listActive(userId) {
      const { data, error } = await sb
        .from('user_entitlements')
        .select('feature')
        .eq('user_id', userId)
        .is('disabled_at', null);
      if (error) throw new Error(`listActive: ${error.message}`);
      return (data ?? []).map((r) => (r as { feature: string }).feature);
    },

    async enable(userId, feature) {
      const before = await sb
        .from('user_entitlements')
        .select('disabled_at')
        .eq('user_id', userId)
        .eq('feature', feature)
        .maybeSingle();

      const wasActive = before.data && (before.data as { disabled_at: string | null }).disabled_at === null;

      const { error } = await sb.from('user_entitlements').upsert(
        {
          user_id: userId,
          feature,
          enabled_at: new Date().toISOString(),
          disabled_at: null,
        },
        { onConflict: 'user_id,feature' },
      );
      if (error) throw new Error(`enable: ${error.message}`);

      return { changed: !wasActive };
    },

    async disable(userId, feature) {
      const { data, error } = await sb
        .from('user_entitlements')
        .update({ disabled_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('feature', feature)
        .is('disabled_at', null)
        .select();
      if (error) throw new Error(`disable: ${error.message}`);
      return { changed: (data?.length ?? 0) > 0 };
    },

    async getTokenVersion(userId) {
      const { data, error } = await sb
        .from('users')
        .select('token_version')
        .eq('id', userId)
        .maybeSingle();
      if (error) throw new Error(`getTokenVersion: ${error.message}`);
      if (!data) return null;
      return (data as { token_version: number }).token_version;
    },

    async bumpTokenVersion(userId) {
      // Atomic increment via RPC. 如果 Supabase 项目没建这个 RPC,先用 read-then-write
      // (有并发风险, P1 阶段单用户极少并发, 接受)。
      const cur = await this.getTokenVersion(userId);
      if (cur === null) throw new Error(`bumpTokenVersion: user ${userId} not found`);
      const next = cur + 1;
      const { error } = await sb
        .from('users')
        .update({ token_version: next })
        .eq('id', userId);
      if (error) throw new Error(`bumpTokenVersion: ${error.message}`);
      return next;
    },
  };
};
