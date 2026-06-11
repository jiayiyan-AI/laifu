/**
 * Token 计量 & 余额 DAO (v2 — 金额制, Drizzle 直连版)
 *
 * 核心职责:
 *   1. recordUsage: 写 usage_events (含 cost_cny 快照) + 扣减 user_balance
 *   2. getBalance:  入口配额检查 / 前端展示
 *
 * 设计要点:
 *   - 免费额度和已用都以 ¥ 计，模型无关
 *   - cost_cny 在写入时算好存进 usage_events，日常聚合直接 sum，不 JOIN pricing
 *   - period_start 跨月 reset 在写入时就地处理 (无外部 cron 依赖)
 *   - 使用事务保证 insert usage_events + upsert balance 的原子性
 *   - 失败抛错，调用方决定是否吞 (建议: 计量失败不阻断 chat，只 log.warn)
 */
import type { Db } from '@lingxi/db';
import { schema } from '@lingxi/db';
import { eq, sql } from 'drizzle-orm';
import type { ContainerChatUsage } from '@lingxi/shared';
import { priceOf } from '../lib/pricing.js';
import { config } from '../config.js';

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

export const makeUsageDao = (db: Db): UsageDao => {
  const ue = schema.usageEvents;
  const ub = schema.userBalance;

  return {
    async recordUsage({ userId, threadId, source, usage }) {
      // provider/model 以 gateway 的 env (config.azure.hermes*) 为权威源, 不信任
      // Hermes 容器回传的 usage.provider/usage.model:
      //   - 容器的 config.yaml 本就是 gateway 按这些 env 渲染下发的, env 才是真相
      //   - 不同 provider/镜像回传的字段口径不一, 易漂移导致 pricing miss → 计 0
      const provider = config.azure.hermesProvider || 'unknown';
      const model = config.azure.hermesModel || 'unknown';
      const price = priceOf(provider, model);

      const input = usage.input_tokens | 0;
      const output = usage.output_tokens | 0;
      const cacheRead = usage.cache_read_tokens | 0;
      const cacheWrite = usage.cache_write_tokens | 0;
      const reasoning = usage.reasoning_tokens | 0;

      // 费用 = input * price_in + output * price_out + cache_read * price_cached
      // cache_write / reasoning 暂不单独计价 (各 provider 规则不同, MVP 简化)
      const costCny = (input * price.in + output * price.out + cacheRead * price.cached) / 1_000_000;

      // 事务保证 insert usage_events + upsert balance 原子性
      await db.transaction(async (tx) => {
        // 1. 写 usage_events
        await tx.insert(ue).values({
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
          cost_cny: String(costCny),
        });

        // 2. 扣减 user_balance (跨月 reset 就地处理)
        const period = monthStart();
        const rows = await tx.select().from(ub).where(eq(ub.user_id, userId)).limit(1);
        const existing = rows[0] ?? null;

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

        await tx.insert(ub).values({
          user_id: userId,
          balance_cny: String(balanceAfter),
          free_quota_cny_month: String(freeQuota),
          used_cny_month: String(usedAfter),
          period_start: period,
          updated_at: new Date(),
        }).onConflictDoUpdate({
          target: ub.user_id,
          set: {
            balance_cny: String(balanceAfter),
            free_quota_cny_month: String(freeQuota),
            used_cny_month: String(usedAfter),
            period_start: period,
            updated_at: new Date(),
          },
        });
      });

      return { cost_cny: costCny };
    },

    async getBalance(userId) {
      const rows = await db.select().from(ub).where(eq(ub.user_id, userId)).limit(1);
      if (rows[0]) {
        const row = rows[0];
        const period = monthStart();
        // 跨月 view-time reset (不写库, 入口检查只关心"本月还能不能用")
        if (row.period_start < period) {
          return {
            balance_cny: Number(row.balance_cny),
            free_quota_cny_month: Number(row.free_quota_cny_month),
            used_cny_month: 0,
            period_start: period,
          };
        }
        return {
          balance_cny: Number(row.balance_cny),
          free_quota_cny_month: Number(row.free_quota_cny_month),
          used_cny_month: Number(row.used_cny_month),
          period_start: row.period_start,
        };
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
