import type { Db } from '@lingxi/db';
import { schema } from '@lingxi/db';
import { eq } from 'drizzle-orm';

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

export const makeObservedStateDao = (db: Db): ObservedStateDao => {
  const t = schema.containerObservedState;
  return {
    async upsert(input) {
      await db.insert(t).values({
        user_id: input.user_id,
        observed_entitlements: input.observed_entitlements,
        observed_token_version: input.observed_token_version,
        reported_at: new Date(),
      }).onConflictDoUpdate({
        target: t.user_id,
        set: {
          observed_entitlements: input.observed_entitlements,
          observed_token_version: input.observed_token_version,
          reported_at: new Date(),
        },
      });
    },

    async get(userId) {
      const rows = await db.select().from(t).where(eq(t.user_id, userId)).limit(1);
      if (!rows[0]) return null;
      const r = rows[0];
      return {
        user_id: r.user_id,
        observed_entitlements: r.observed_entitlements,
        observed_token_version: r.observed_token_version,
        reported_at: r.reported_at?.toISOString(),
      };
    },
  };
};
