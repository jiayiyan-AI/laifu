#!/usr/bin/env -S node --experimental-strip-types
/**
 * admin-balance.ts — 给用户充值 / 调免费额度 / 看余额
 *
 * 临时用: MVP 阶段不接支付, 运营手工跳过 Supabase 改 user_balance。
 * 正式产品化后走支付回调。
 *
 * 需要环境: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (走与 gateway 同一权限)
 *
 * 用法:
 *   pnpm tsx scripts/admin-balance.ts show <user_id>
 *   pnpm tsx scripts/admin-balance.ts topup <user_id> <cny>        — 充值余额
 *   pnpm tsx scripts/admin-balance.ts quota <user_id> <cny>        — 设每月免费额度(¥)
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env['SUPABASE_URL'];
const key = process.env['SUPABASE_SERVICE_ROLE_KEY'];
if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required');
  process.exit(1);
}
const sb = createClient(url, key);

const monthStart = (): string => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
};

const fetchOrInit = async (userId: string) => {
  const cur = await sb.from('user_balance').select('*').eq('user_id', userId).maybeSingle();
  if (cur.error) throw new Error(cur.error.message);
  return cur.data ?? {
    user_id: userId,
    balance_cny: 0,
    free_quota_cny_month: 0,
    used_cny_month: 0,
    period_start: monthStart(),
  };
};

const upsert = async (row: Record<string, unknown>) => {
  const { error } = await sb.from('user_balance').upsert(
    { ...row, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' },
  );
  if (error) throw new Error(error.message);
};

const [, , cmd, userId, valueRaw] = process.argv;
if (!cmd || !userId) {
  console.error('usage: admin-balance.ts <show|topup|quota> <user_id> [value]');
  process.exit(2);
}

const main = async () => {
  const row = await fetchOrInit(userId);
  if (cmd === 'show') {
    console.log(JSON.stringify(row, null, 2));
    return;
  }
  const v = Number(valueRaw);
  if (!Number.isFinite(v)) throw new Error('value must be a number');
  if (cmd === 'topup') {
    await upsert({ ...row, balance_cny: Number(row.balance_cny) + v });
    console.log(`OK; new balance_cny=${Number(row.balance_cny) + v}`);
  } else if (cmd === 'quota') {
    await upsert({ ...row, free_quota_cny_month: v });
    console.log(`OK; free_quota_cny_month=¥${v}`);
  } else {
    throw new Error(`unknown cmd: ${cmd}`);
  }
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
