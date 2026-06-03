import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { makeEntitlementsDao, type EntitlementsDao } from '../../src/db/entitlements-dao.js';

// Real local Supabase. Skip suite if env not configured.
const SUPABASE_URL = process.env['SUPABASE_URL'] ?? 'http://127.0.0.1:54321';
const SUPABASE_SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'];

const TEST_FEATURE = 'test_feature_p1';

describe.skipIf(!SUPABASE_SERVICE_ROLE_KEY)('EntitlementsDao (real Supabase)', () => {
  let sb: SupabaseClient;
  let dao: EntitlementsDao;
  let userId: string;

  beforeAll(() => {
    sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    dao = makeEntitlementsDao(sb);
  });

  beforeEach(async () => {
    // Create a fresh test user; clean up any prior test rows
    const ts = Date.now();
    const ext = `p1-dao-test-${ts}`;
    const { data: u, error } = await sb.from('users')
      .insert({ provider: 'test', external_id: ext, email: `${ext}@test.local` })
      .select('id').single();
    if (error || !u) throw new Error(`test setup failed: ${error?.message}`);
    userId = (u as { id: string }).id;
  });

  describe('listActive', () => {
    it('returns empty for new user', async () => {
      expect(await dao.listActive(userId)).toEqual([]);
    });

    it('returns active features after enable', async () => {
      await dao.enable(userId, TEST_FEATURE);
      expect(await dao.listActive(userId)).toEqual([TEST_FEATURE]);
    });

    it('does not return disabled features', async () => {
      await dao.enable(userId, TEST_FEATURE);
      await dao.disable(userId, TEST_FEATURE);
      expect(await dao.listActive(userId)).toEqual([]);
    });
  });

  describe('enable / disable round-trip', () => {
    it('enable on new feature returns changed=true', async () => {
      const r = await dao.enable(userId, TEST_FEATURE);
      expect(r.changed).toBe(true);
    });

    it('enable on already-active feature returns changed=false', async () => {
      await dao.enable(userId, TEST_FEATURE);
      const r = await dao.enable(userId, TEST_FEATURE);
      expect(r.changed).toBe(false);
    });

    it('disable→enable restores active (re-enable returns changed=true)', async () => {
      await dao.enable(userId, TEST_FEATURE);
      await dao.disable(userId, TEST_FEATURE);
      const re = await dao.enable(userId, TEST_FEATURE);
      expect(re.changed).toBe(true);
      expect(await dao.listActive(userId)).toEqual([TEST_FEATURE]);
    });

    it('disable on non-active feature returns changed=false', async () => {
      const r = await dao.disable(userId, TEST_FEATURE);
      expect(r.changed).toBe(false);
    });
  });

  describe('token_version', () => {
    it('new user starts at 0', async () => {
      expect(await dao.getTokenVersion(userId)).toBe(0);
    });

    it('bumpTokenVersion increments by 1', async () => {
      const before = await dao.getTokenVersion(userId);
      const next = await dao.bumpTokenVersion(userId);
      expect(next).toBe((before ?? 0) + 1);
      expect(await dao.getTokenVersion(userId)).toBe(next);
    });

    it('getTokenVersion returns null for unknown user', async () => {
      expect(await dao.getTokenVersion('00000000-0000-0000-0000-000000000000')).toBe(null);
    });

    it('bumpTokenVersion throws for unknown user', async () => {
      await expect(dao.bumpTokenVersion('00000000-0000-0000-0000-000000000000')).rejects.toThrow();
    });
  });
});
