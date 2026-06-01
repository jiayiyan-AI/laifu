/**
 * wechat_bindings 表的类型化 DAO。
 *
 * 集中所有 SQL 在这,PollManager / 路由 / handleInbound 都用这个 interface,
 * 不直接拼 supabase 查询 — 便于以后换 ORM/拆 schema/加缓存。
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface WechatBinding {
  id: string;
  user_id: string;
  ilink_bot_id: string;
  bot_token: string;
  base_url: string;
  updates_cursor: string | null;
  is_active: boolean;
  thread_id: string | null;
  bound_at: string;
}

export interface WechatBindingDao {
  /** PollManager.startAll 用: 拉所有活跃绑定。 */
  listActive(): Promise<WechatBinding[]>;

  /** 当前用户的绑定 (含 inactive); GET /api/wechat/bind 用。 */
  getByUserId(userId: string): Promise<WechatBinding | null>;

  /** 扫码 confirmed 时: 新建或换绑(同 user_id 直接 update)。 */
  upsertByUserId(args: {
    user_id: string;
    ilink_bot_id: string;
    bot_token: string;
    base_url: string;
  }): Promise<WechatBinding>;

  /** 长轮询游标推进。 */
  updateCursor(id: string, cursor: string): Promise<void>;

  /** 1 用户 1 thread 写回 binding 的 thread_id。 */
  bindThread(id: string, threadId: string): Promise<void>;

  /** 解绑 / session_expired: 软删,留行作历史。 */
  deactivate(id: string): Promise<void>;
}

interface UpsertArgs {
  user_id: string;
  ilink_bot_id: string;
  bot_token: string;
  base_url: string;
}

export const makeWechatBindingDao = (sb: SupabaseClient): WechatBindingDao => ({
  async listActive() {
    const { data, error } = await sb
      .from('wechat_bindings')
      .select('*')
      .eq('is_active', true);
    if (error) throw new Error(`listActive failed: ${error.message}`);
    return (data ?? []) as WechatBinding[];
  },

  async getByUserId(userId) {
    const { data, error } = await sb
      .from('wechat_bindings')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error(`getByUserId failed: ${error.message}`);
    return (data as WechatBinding) ?? null;
  },

  async upsertByUserId(args: UpsertArgs) {
    // ON CONFLICT(user_id) UPDATE: 同号续期 / 换号都行,is_active 强制设回 true
    const { data, error } = await sb
      .from('wechat_bindings')
      .upsert(
        { ...args, is_active: true, updates_cursor: null },
        { onConflict: 'user_id' },
      )
      .select('*')
      .single();
    if (error || !data) throw new Error(`upsertByUserId failed: ${error?.message}`);
    return data as WechatBinding;
  },

  async updateCursor(id, cursor) {
    const { error } = await sb
      .from('wechat_bindings')
      .update({ updates_cursor: cursor })
      .eq('id', id);
    if (error) throw new Error(`updateCursor failed: ${error.message}`);
  },

  async bindThread(id, threadId) {
    const { error } = await sb
      .from('wechat_bindings')
      .update({ thread_id: threadId })
      .eq('id', id);
    if (error) throw new Error(`bindThread failed: ${error.message}`);
  },

  async deactivate(id) {
    const { error } = await sb
      .from('wechat_bindings')
      .update({ is_active: false })
      .eq('id', id);
    if (error) throw new Error(`deactivate failed: ${error.message}`);
  },
});
