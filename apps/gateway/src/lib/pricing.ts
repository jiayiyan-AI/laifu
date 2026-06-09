/**
 * 模型单价查询 — 从 pricing 表读取当前生效价格
 *
 * gateway 启动时加载 pricing_current view 到内存 cache，
 * 避免每次 chat 都 query。提供 refresh() 方法供 admin 调价后手动刷新。
 *
 * 未知 provider+model → 返回 { in: 0, out: 0, cached: 0 }，仅记 token 不计费，
 * 避免一个没登记的 model 把 chat 链路阻断。log.warn 报警，补登记后新 chat 自动起算。
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { log } from './logger.js';

export interface ModelPrice {
  provider: string;
  model: string;
  /** ¥ per 1_000_000 input tokens */
  in: number;
  /** ¥ per 1_000_000 output tokens */
  out: number;
  /** ¥ per 1_000_000 cached tokens */
  cached: number;
}

const ZERO: Omit<ModelPrice, 'provider' | 'model'> = { in: 0, out: 0, cached: 0 };

/** key = "provider:model" */
let cache: Map<string, ModelPrice> = new Map();

const key = (provider: string, model: string) => `${provider}:${model}`;

/**
 * 从 pricing_current view 加载全部当前价格到内存。
 * 启动时调一次；admin 调价后可手动调 refresh。
 */
export const loadPricing = async (sb: SupabaseClient): Promise<void> => {
  const { data, error } = await sb
    .from('pricing_current')
    .select('provider, model, price_in, price_out, price_cached');

  if (error) {
    log.warn({ event: 'pricing.load.failed', err: error.message });
    return; // 保留旧 cache，不清空
  }

  const next = new Map<string, ModelPrice>();
  for (const row of data ?? []) {
    next.set(key(row.provider, row.model), {
      provider: row.provider,
      model: row.model,
      in: Number(row.price_in),
      out: Number(row.price_out),
      cached: Number(row.price_cached),
    });
  }
  cache = next;
  log.info({ event: 'pricing.loaded', count: cache.size });
};

/**
 * 查当前价格。找不到返回零价格（不阻断，只 warn）。
 */
export const priceOf = (provider: string | null | undefined, model: string | null | undefined): Omit<ModelPrice, 'provider' | 'model'> => {
  if (!provider || !model) return ZERO;
  const hit = cache.get(key(provider, model));
  if (hit) return hit;

  // fallback: 只按 model 匹配（兼容 provider 不一致的边界情况）
  for (const [, v] of cache) {
    if (v.model === model) return v;
  }

  log.warn({ event: 'pricing.miss', provider, model });
  return ZERO;
};
