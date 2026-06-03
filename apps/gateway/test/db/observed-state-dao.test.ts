import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { makeObservedStateDao, type ObservedStateDao } from '../../src/db/observed-state-dao.js';

const SUPABASE_URL = process.env['SUPABASE_URL'] ?? 'http://127.0.0.1:54321';
const SUPABASE_SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'];

describe.skipIf(!SUPABASE_SERVICE_ROLE_KEY)('ObservedStateDao (real Supabase)', () => {
  let sb: SupabaseClient;
  let dao: ObservedStateDao;
  let userId: string;

  beforeAll(() => {
    sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    dao = makeObservedStateDao(sb);
  });

  beforeEach(async () => {
    const ts = Date.now();
    const ext = `p1-obs-test-${ts}`;
    const { data: u, error } = await sb.from('users')
      .insert({ provider: 'test', external_id: ext, email: `${ext}@test.local` })
      .select('id').single();
    if (error || !u) throw new Error(`test setup failed: ${error?.message}`);
    userId = (u as { id: string }).id;
  });

  it('get returns null when never upserted', async () => {
    expect(await dao.get(userId)).toBe(null);
  });

  it('upsert then get round-trips the values', async () => {
    await dao.upsert({
      user_id: userId,
      observed_entitlements: ['cloud'],
      observed_token_version: 3,
    });
    const got = await dao.get(userId);
    expect(got).toMatchObject({
      user_id: userId,
      observed_entitlements: ['cloud'],
      observed_token_version: 3,
    });
    expect(got!.reported_at).toBeDefined();
  });

  it('upsert overwrites previous value', async () => {
    await dao.upsert({
      user_id: userId,
      observed_entitlements: ['cloud'],
      observed_token_version: 1,
    });
    await dao.upsert({
      user_id: userId,
      observed_entitlements: [],
      observed_token_version: 2,
    });
    const got = await dao.get(userId);
    expect(got!.observed_entitlements).toEqual([]);
    expect(got!.observed_token_version).toBe(2);
  });
});
