/**
 * Token 计量 & 余额 DAO (v2 — 金额制)
 *
 * 核心职责:
 *   1. recordUsage: 写 usage_events (含 cost_cny 快照) + 扣减 user_balance
 *   2. getBalance:  入口配额检查 / 前端展示
 *
 * 设计要点:
 *   - 免费额度和已用都以 ¥ 计，模型无关
 *   - cost_cny 在写入时算好存进 usage_events，日常聚合直接 sum，不 JOIN pricing
 *   - period_start 跨月 reset 在写入时就地处理 (无外部 cron 依赖)
 *   - 失败抛错，调用方决定是否吞 (建议: 计量失败不阻断 chat，只 log.warn)
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ContainerChatUsage } from '@lingxi/shared';
import { priceOf } from '../lib/pricing.js';

export interface UsageInsertArgs {
  userId: string;
  threadId: string | null;
  source: 'web' | 'wechat';
  usage: ContainerChatUsage;
}

export interface BalanceRow {
  balance_cny: number;
  free_quota_cny_month: number;
  used_cny_month: number;
  period_start: string; // ISO date (YYYY-MM-DD)
}

export interface UsageDao {
  /** 写 usage_events + 扣减 user_balance; 返回本次 cost。 */
  recordUsage(args: UsageInsertArgs): Promise<{ cost_cny: number }>;
  /** 入口配额检查 / 前端展示: 拿余额行，自动 upsert 新用户。 */
  getBalance(userId: string): Promise<BalanceRow>;
}

const monthStart = (d: Date = new Date()): string => {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
};

export const makeUsageDao = (sb: SupabaseClient): UsageDao => {
  return {
    async recordUsage({ userId, threadId, source, usage }) {
      const provider = usage.provider ?? 'unknown';
      const model = usage.model ?? 'unknown';
      const price = priceOf(provider, model);

      const input = usage.input_tokens | 0;
      const output = usage.output_tokens | 0;
      const cacheRead = usage.cache_read_tokens | 0;
      const cacheWrite = usage.cache_write_tokens | 0;
      const reasoning = usage.reasoning_tokens | 0;

      // 费用 = input * price_in + output * price_out + cache_read * price_cached
      // cache_write / reasoning 暂不单独计价 (各 provider 规则不同, MVP 简化)
      const costCny = (input * price.in + output * price.out + cacheRead * price.cached) / 1_000_000;

      // 1. 写 usage_events
      const { error: insErr } = await sb.from('usage_events').insert({
        user_id: userId,
        thread_id: threadId,
        source,
        provider,
        model,
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cacheRead,
        cache_write_tokens: cacheWrite,
        reasoning_tokens: reasoning,
        cost_cny: costCny,
      });
      if (insErr) throw new Error(`recordUsage insert: ${insErr.message}`);

      // 2. 扣减 user_balance (跨月 reset 就地处理)
      const period = monthStart();
      const cur = await sb
        .from('user_balance').select('*').eq('user_id', userId).maybeSingle();
      if (cur.error) throw new Error(`recordUsage select: ${cur.error.message}`);

      const existing = cur.data as BalanceRow | null;
      const crossedMonth = existing && existing.period_start < period;
      const usedBefore = !existing || crossedMonth ? 0 : Number(existing.used_cny_month);
      const balanceBefore = Number(existing?.balance_cny ?? 0);
      const freeQuota = Number(existing?.free_quota_cny_month ?? 0);

      const usedAfter = usedBefore + costCny;

      // 超出免费额度的增量部分才扣余额
      const chargeableBefore = Math.max(0, usedBefore - freeQuota);
      const chargeableAfter = Math.max(0, usedAfter - freeQuota);
      const chargeCny = chargeableAfter - chargeableBefore;
      const balanceAfter = balanceBefore - chargeCny;

      const { error: upErr } = await sb.from('user_balance').upsert({
        user_id: userId,
        balance_cny: balanceAfter,
        free_quota_cny_month: freeQuota,
        used_cny_month: usedAfter,
        period_start: period,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });
      if (upErr) throw new Error(`recordUsage upsert: ${upErr.message}`);

      return { cost_cny: costCny };
    },

    async getBalance(userId) {
      const cur = await sb
        .from('user_balance').select('*').eq('user_id', userId).maybeSingle();
      if (cur.error) throw new Error(`getBalance: ${cur.error.message}`);
      if (cur.data) {
        const row = cur.data as BalanceRow;
        // 跨月 view-time reset (不写库, 入口检查只关心"本月还能不能用")
        const period = monthStart();
        if (row.period_start < period) {
          return { ...row, used_cny_month: 0, period_start: period };
        }
        return row;
      }
      return {
        balance_cny: 0,
        free_quota_cny_month: 0,
        used_cny_month: 0,
        period_start: monthStart(),
      };
    },
  };
};
